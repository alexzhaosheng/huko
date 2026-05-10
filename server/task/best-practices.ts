/**
 * server/task/best-practices.ts
 *
 * Phase-capability-aware expert checklist injection.
 *
 * When the LLM activates a phase (via plan(update) for the initial
 * phase, or plan(advance) for the next), the plan handler asks this
 * module for a "best practices" block to attach to the tool_result.
 *
 * huko's capabilities are role names — strings like "coding", "writing",
 * "research". Each capability resolves to a role via loadRole(name);
 * the role's body is the source of best-practices.
 *
 * Two extraction modes:
 *   - If the role body has a `## Best Practices` (or `## Best practices`)
 *     section, ONLY that section is used. Lets a role file double as a
 *     full persona prompt (rest of the body) AND a concise checklist.
 *   - Otherwise the whole body is used (capped at MAX_BODY_CHARS).
 *
 * Why pull from role bodies instead of a dedicated table:
 *   - Role markdown is already the user-extensible vocabulary.
 *   - Drop a ~/.huko/roles/<x>.md and <x> becomes a usable capability,
 *     no code change required.
 *   - Project-local overrides naturally compose.
 */

import { loadRole } from "../roles/index.js";

/** Per-capability cap for body text (chars). Avoids context blowout. */
const MAX_BODY_CHARS = 1500;

/**
 * Build the best-practices system message to attach when a phase is
 * activated. Returns null if no capabilities yielded any matching role.
 */
export async function buildBestPracticesInjection(
  phaseId: number,
  phaseTitle: string,
  capabilities: string[] | undefined,
  cwd: string = process.cwd(),
): Promise<string | null> {
  if (!capabilities || capabilities.length === 0) return null;

  const blocks: string[] = [];
  for (const name of capabilities) {
    const block = await tryLoadRoleBody(name, cwd);
    if (block) blocks.push(block);
  }

  if (blocks.length === 0) return null;

  return [
    `[Phase ${phaseId}: ${phaseTitle} — Expert Checklist]`,
    `The following best practices apply to this phase. Follow these guidelines:`,
    ``,
    blocks.join("\n\n"),
  ].join("\n");
}

// ─── Section extraction ──────────────────────────────────────────────────────

/**
 * Pull a `## Best Practices` section out of a role body. Matches a
 * level-2 heading whose text is "best practices" (case-insensitive),
 * and returns everything from the heading line up to (but excluding)
 * the next level-2 heading or end of body.
 *
 * Exported so tests can pin the matcher independently.
 */
export function extractBestPracticesSection(body: string): string | null {
  // Find the heading. Anchor to start-of-line; allow either CRLF or LF.
  const re = /^##[ \t]+best practices\b.*$/im;
  const match = re.exec(body);
  if (!match) return null;

  const start = match.index;
  // Look for the NEXT level-2 heading after this one, to know where
  // the section ends. Same-line matching only (multiline default).
  const tail = body.slice(start + match[0].length);
  const nextHeadingRe = /^##[ \t]+\S/m;
  const next = nextHeadingRe.exec(tail);
  const sectionRaw = next === null ? body.slice(start) : body.slice(start, start + match[0].length + next.index);

  return sectionRaw.trim();
}

// ─── Internals ───────────────────────────────────────────────────────────────

async function tryLoadRoleBody(name: string, cwd: string): Promise<string | null> {
  // Refuse anything that isn't a plain identifier — defends against
  // path-traversal-shaped capability names.
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) return null;

  let body: string;
  try {
    const role = await loadRole(name, cwd);
    body = role.body;
  } catch {
    return null;
  }

  // Prefer a dedicated `## Best Practices` block if present; fall back
  // to the whole body (capped) otherwise.
  const dedicated = extractBestPracticesSection(body);
  const source = dedicated ?? body;

  const trimmed = source.trim();
  if (trimmed.length === 0) return null;

  const truncated =
    trimmed.length > MAX_BODY_CHARS
      ? trimmed.slice(0, MAX_BODY_CHARS) + "\n…(truncated)"
      : trimmed;

  return [`[Role: ${name}]`, truncated].join("\n");
}
