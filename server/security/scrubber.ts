/**
 * server/security/scrubber.ts
 *
 * The redaction pipeline: turn outbound text containing secrets into
 * the same text with every secret replaced by a placeholder, AND
 * record the mapping so the inverse direction (placeholder → raw) can
 * be performed when the LLM emits a tool call referencing the
 * placeholder.
 *
 * Two sources of "what's a secret":
 *
 *   1. **Vault** (`server/security/vault.ts`)
 *      User-registered exact strings. Substring match. The vault
 *      entry's `name` becomes the placeholder label.
 *
 *   2. **Built-in + user-config regex patterns**
 *      (`./builtin-redact-patterns.ts` + `config.safety.redactPatterns`)
 *      Pattern-matched. Auto-allocated placeholder name `secret-<N>`
 *      where N is monotone within a session.
 *
 * Pipeline (`scrubAndRecord`):
 *   (a) Pull existing substitutions for this session (already-known
 *       raw values get their existing placeholder — keeps placeholders
 *       stable across turns).
 *   (b) Run vault matches (longest-first to avoid prefix-swallow).
 *   (c) Run regex matches; for each unique match, look up by raw
 *       value first (idempotence), allocate `secret-<N>` if new.
 *   (d) Persist any newly-allocated mappings.
 *
 * Pipeline (`expandPlaceholders`):
 *   - Walks the input string, finds `[REDACTED:<name>]`, looks each up
 *     in the substitution table, replaces with raw value. Unknown
 *     placeholders are left as-is (don't crash; the LLM might be
 *     hallucinating a placeholder we've never created).
 *
 * The two functions are intentionally simple — substring/regex on
 * strings — because complexity here is a security risk.
 */

import type { SessionPersistence, SubstitutionRecord } from "../persistence/types.js";
import type { SessionType } from "../../shared/types.js";
import { getConfig, isConfigLoaded } from "../config/index.js";
import { loadVault } from "./vault.js";
import { BUILTIN_REDACT_PATTERNS, type RedactPattern } from "./builtin-redact-patterns.js";

// ─── Public API ─────────────────────────────────────────────────────────────

export type ScrubContext = {
  sessionId: number;
  sessionType: SessionType;
  persistence: SessionPersistence;
};

/**
 * Scrub `text`, persisting any new substitutions to the session table.
 * Returns the scrubbed string. Empty / no-secret input returns
 * unchanged.
 *
 * Idempotence: two calls in the same session with the same raw secret
 * produce the SAME placeholder.
 */
export async function scrubAndRecord(
  text: string,
  ctx: ScrubContext,
): Promise<string> {
  if (text.length === 0) return text;

  let out = text;

  // (b) Vault: longest-first so a vault entry that's a prefix of
  // another doesn't swallow the longer secret. (Same value stored in
  // multiple vault entries: first one wins.)
  //
  // The substitutions table stores the BARE label (e.g. "github-token"
  // or "secret-3"); the bracketed form `[REDACTED:label]` is just the
  // rendered representation in text. expandPlaceholders parses the
  // brackets back to the bare label before looking up.
  const vault = loadVault();
  const sortedVault = [...vault].sort((a, b) => b.value.length - a.value.length);
  for (const entry of sortedVault) {
    if (out.indexOf(entry.value) < 0) continue;
    const rendered = renderPlaceholder(entry.name);
    out = replaceAll(out, entry.value, rendered);
    await ctx.persistence.substitutions.record({
      sessionId: ctx.sessionId,
      sessionType: ctx.sessionType,
      placeholder: entry.name,
      rawValue: entry.value,
      source: "vault",
    });
  }

  // (c) Regex: built-in + user-config, all unioned.
  const patterns = collectAllPatterns();
  if (patterns.length === 0) return out;

  // Compile each individually. We don't use a single mega-regex with
  // alternation because we need to track which pattern matched (for
  // the source label). The per-pattern compile is hot-path-cached
  // inside `compilePattern`.
  for (const pat of patterns) {
    const regex = compilePattern(pat);
    if (!regex) continue;

    // Collect unique matches first; THEN do the substitution. This
    // keeps the regex's exec-loop independent of the mutation we're
    // about to do on `out`.
    const matches = new Set<string>();
    let m: RegExpExecArray | null;
    regex.lastIndex = 0;
    while ((m = regex.exec(out)) !== null) {
      if (m[0].length > 0) matches.add(m[0]);
      // Defensive: zero-length match would loop forever.
      if (m.index === regex.lastIndex) regex.lastIndex++;
    }

    for (const raw of matches) {
      // Idempotence: if we've already assigned a placeholder (bare
      // label) to this raw value, reuse it.
      const existing = await ctx.persistence.substitutions.lookupByRaw(
        ctx.sessionId,
        ctx.sessionType,
        raw,
      );
      const label = existing ?? (await allocateScrubLabel(ctx));
      out = replaceAll(out, raw, renderPlaceholder(label));
      if (!existing) {
        await ctx.persistence.substitutions.record({
          sessionId: ctx.sessionId,
          sessionType: ctx.sessionType,
          placeholder: label,
          rawValue: raw,
          source: `scrub:${pat.name}`,
        });
      }
    }
  }

  return out;
}

/**
 * Walk `text` and expand any `[REDACTED:<name>]` back to its raw
 * value (looked up in the session substitution table). Unknown
 * placeholders pass through verbatim.
 *
 * Used by the tool-execute step BEFORE handing args to a tool, so the
 * LLM can symbolically reference a secret it never saw.
 */
export async function expandPlaceholders(
  text: string,
  ctx: ScrubContext,
): Promise<string> {
  if (text.length === 0 || text.indexOf("[REDACTED:") < 0) return text;

  // Greedy-but-bounded: placeholder names are limited to the same
  // shape we use when allocating (`vault-name` or `secret-N`), all
  // matching `[A-Za-z0-9_\-]+`. Anchoring on `]` guarantees we don't
  // span unrelated text.
  const re = /\[REDACTED:([A-Za-z0-9_\-]+)\]/g;
  const matches: Array<{ full: string; name: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    matches.push({ full: m[0], name: m[1]! });
  }
  if (matches.length === 0) return text;

  let out = text;
  // Resolve each unique placeholder once even if it appears N times.
  const seen = new Set<string>();
  for (const m of matches) {
    if (seen.has(m.full)) continue;
    seen.add(m.full);
    const raw = await ctx.persistence.substitutions.lookupByPlaceholder(
      ctx.sessionId,
      ctx.sessionType,
      m.name,
    );
    if (raw === null) continue; // unknown placeholder — leave verbatim
    out = replaceAll(out, m.full, raw);
  }
  return out;
}

/**
 * Recursively expand placeholders inside a JSON-shaped value. Used by
 * tool-execute to handle nested args (e.g. `{"command": "git push X"}`)
 * without forcing every tool to opt-in to placeholder handling.
 */
export async function expandPlaceholdersDeep(
  value: unknown,
  ctx: ScrubContext,
): Promise<unknown> {
  if (typeof value === "string") return await expandPlaceholders(value, ctx);
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value) out.push(await expandPlaceholdersDeep(item, ctx));
    return out;
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = await expandPlaceholdersDeep(v, ctx);
    }
    return out;
  }
  return value;
}

// ─── Internals ──────────────────────────────────────────────────────────────

function renderPlaceholder(label: string): string {
  return `[REDACTED:${label}]`;
}

async function allocateScrubLabel(ctx: ScrubContext): Promise<string> {
  // Find the next free `secret-<N>` for this session. We could
  // maintain a counter in memory but it'd reset across processes;
  // querying the table is the only correct answer for a fresh
  // process resuming a session. Cheap: substitution rows per session
  // typically < 100.
  const existing = await ctx.persistence.substitutions.listForSession(
    ctx.sessionId,
    ctx.sessionType,
  );
  let max = 0;
  for (const r of existing) {
    const m = /^secret-(\d+)$/.exec(r.placeholder);
    if (m) {
      const n = parseInt(m[1]!, 10);
      if (n > max) max = n;
    }
  }
  return `secret-${max + 1}`;
}

function collectAllPatterns(): RedactPattern[] {
  const out: RedactPattern[] = [...BUILTIN_REDACT_PATTERNS];
  if (!isConfigLoaded()) return out;
  const userPatterns = getConfig().safety.redactPatterns;
  if (Array.isArray(userPatterns)) {
    for (const p of userPatterns) {
      if (
        p !== null &&
        typeof p === "object" &&
        typeof (p as RedactPattern).name === "string" &&
        typeof (p as RedactPattern).pattern === "string"
      ) {
        out.push({ name: (p as RedactPattern).name, pattern: (p as RedactPattern).pattern });
      }
    }
  }
  return out;
}

const _compileCache = new Map<string, RegExp | null>();
function compilePattern(p: RedactPattern): RegExp | null {
  const cached = _compileCache.get(p.pattern);
  if (cached !== undefined) return cached;
  try {
    const re = new RegExp(p.pattern, "g");
    _compileCache.set(p.pattern, re);
    return re;
  } catch {
    // Bad regex from user config — log once via console.error and
    // skip. Don't crash the scrubber.
    process.stderr.write(
      `huko: scrubber skipping invalid regex for "${p.name}": ${p.pattern}\n`,
    );
    _compileCache.set(p.pattern, null);
    return null;
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * String.prototype.replaceAll polyfill that's simpler and faster for
 * our use: literal substring (not regex) replacement. Avoids the
 * subtle quirks of `String.prototype.replaceAll` with `$` chars in the
 * replacement string (we'd need to escape `$` to `$$` otherwise).
 */
function replaceAll(haystack: string, needle: string, replacement: string): string {
  if (needle.length === 0) return haystack;
  const escaped = escapeRegex(needle);
  return haystack.replace(new RegExp(escaped, "g"), () => replacement);
}
