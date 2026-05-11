/**
 * server/safety/scaffold.ts
 *
 * Generates the `safety` section template for `huko safety init`.
 *
 * Design points:
 *   - Idempotent: never overwrites an existing `safety` block.
 *     If one is already present, the caller short-circuits and tells
 *     the operator to `huko safety list` instead.
 *   - Lists ONLY the moderate / dangerous tools (the ones that have
 *     external-facing side effects). Safe read-only tools don't get
 *     a stub — fewer noise lines, and rule slots are still legal for
 *     them via direct editing.
 *   - Embeds `_comment*` keys explaining each section. The config
 *     loader strips them on read (see loader.ts).
 *   - Uses native JSON literal syntax (no YAML, no special encoder).
 */

import { MATCH_FIELDS } from "./policy.js";
import {
  isWritableTool,
  type ServerToolDefinition,
} from "../task/tools/registry.js";
import { listToolNames, getTool } from "../task/tools/registry.js";

// ─── Template shape ──────────────────────────────────────────────────────────

/**
 * The literal JSON object that `huko safety init` injects under
 * `safety` in the chosen scope's `config.json`. Plain object — not a
 * stringified blob — so the writer can preserve any sibling fields the
 * user already has (mode, task, compaction, …).
 */
export function buildSafetyTemplate(): Record<string, unknown> {
  const toolRules = buildToolRulesTemplate();

  return {
    _comment:
      "huko safety policy. See `huko safety list` for the live view.",
    _comment_levels:
      "Default action per tool dangerLevel. Choices: \"auto\" | \"prompt\" | \"deny\".",
    byDangerLevel: {
      safe: "auto",
      moderate: "auto",
      dangerous: "prompt",
    },
    _comment_rules:
      "Per-tool patterns. Default: case-sensitive literal-prefix match. " +
      "Prefix a pattern with `re:` for a regex (ECMAScript syntax).",
    _comment_rules_precedence:
      "Precedence: deny > allow > requireConfirm > byDangerLevel.",
    _comment_rules_layered:
      "Layered merge: project layer UNIONS into global. Project never " +
      "silently relaxes a global constraint; to lift a global deny, edit " +
      "the global file.",
    _comment_rules_noninteractive:
      "In -y / HUKO_NON_INTERACTIVE=1 runs, `prompt` decisions are " +
      "fail-closed (treated as deny). To auto-execute in CI, unset the " +
      "rule or add an explicit `allow` pattern.",
    toolRules,
  };
}

/**
 * Built-in read-only bash command prefixes. Prefilled into the scaffold's
 * `bash.allow` so an operator who opts into safety still gets transparent
 * pass-through for the common "read what's there" commands, even under
 * `-y` (where prompts fail-closed).
 *
 * Coverage rationale:
 *   - Inspect filesystem:    ls, cat, head, tail, file, stat, wc
 *   - Search / count:        grep
 *   - Shell info:            pwd, echo, which, whoami, date, uname
 *
 * Deliberately omitted (each has a footgun):
 *   - `find`  — `find . -delete` deletes files
 *   - `env`   — dumps env vars to stdout; can leak secrets into LLM ctx
 *   - `du`    — can spike CPU / disk I/O on huge trees
 *   - `cd`    — common but stateful; chains like `cd /tmp && rm` would
 *                still match by prefix and bypass the gate
 *
 * Prefix-match limit: patterns anchor at command START. Compound commands
 * like `ls /tmp && rm -rf foo` start with `ls` and DO match — but they
 * also DON'T match (the `\b` boundary stops at `&&`). The regex form
 * `^ls\b` means the FIRST word must be `ls` standalone, then anything.
 * Chains like `true && ls` fall through to byDangerLevel (no match).
 */
const DEFAULT_BASH_READ_ALLOW: readonly string[] = [
  "re:^ls\\b",
  "re:^cat\\b",
  "re:^head\\b",
  "re:^tail\\b",
  "re:^wc\\b",
  "re:^grep\\b",
  "re:^pwd\\b",
  "re:^echo\\b",
  "re:^which\\b",
  "re:^whoami\\b",
  "re:^date\\b",
  "re:^uname\\b",
  "re:^stat\\b",
  "re:^file\\b",
];

/**
 * Build the per-tool rule stubs. Walks the live tool registry and
 * includes only tools that (a) are registered AND (b) write or execute
 * something the operator might want a confirmation gate on. Read-only
 * tools fall through to `byDangerLevel.safe` and don't need stubs.
 *
 * Bash gets `DEFAULT_BASH_READ_ALLOW` prefilled so `-y` runs can still
 * do `ls`, `cat`, etc. without tripping fail-closed.
 */
function buildToolRulesTemplate(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const name of listToolNames()) {
    const tool = getTool(name);
    if (!tool) continue;
    if (!isWritableTool(tool.definition)) continue;
    const fields = MATCH_FIELDS[name] ?? [];
    const base = {
      _comment:
        fields.length > 0
          ? `Patterns match against: ${fields.map((f) => "`" + f + "`").join(", ")}.`
          : "No matchable arguments — falls through to byDangerLevel.",
      deny: [] as string[],
      allow: [] as string[],
      requireConfirm: [] as string[],
    };
    if (name === "bash") {
      out[name] = {
        ...base,
        _comment_allow:
          "Pre-populated read-only command prefixes. Anchored at the FIRST word — chains like `ls && rm` fall through (\\b stops at &&).",
        allow: [...DEFAULT_BASH_READ_ALLOW],
      };
    } else {
      out[name] = base;
    }
  }
  return out;
}

// Re-export so consumers don't have to know about the registry helper
export { isWritableTool };

// We avoid pulling in the live tool's full type here — only need the
// shape. Re-export `ServerToolDefinition` via type-only for callers
// that DO need the broader type.
export type { ServerToolDefinition };
