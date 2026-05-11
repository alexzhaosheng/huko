/**
 * server/safety/policy.ts
 *
 * Pure decision engine for tool-call safety. Given a tool name, its
 * arguments, the merged `HukoConfig.safety` section, and the tool's
 * `dangerLevel`, returns one of:
 *
 *   - { action: "auto"   }                                 — run the handler
 *   - { action: "deny",   reason, matchedPattern }         — refuse before run
 *   - { action: "prompt", reason, matchedPattern }         — ask the operator
 *
 * No I/O. No async. No globals. Easy to unit-test the entire matrix.
 *
 * Precedence (per call), each step short-circuits on match:
 *   1. Per-tool `deny`           → deny
 *   2. Per-tool `allow`          → auto
 *   3. Per-tool `requireConfirm` → prompt
 *   4. Fallback: `byDangerLevel[<tool's intrinsic level>]`
 *
 * Pattern syntax:
 *   - Default: case-sensitive **literal-prefix** match against the
 *     tool's matchable argument(s).
 *   - `re:<regex>`: ECMAScript regex (full match anywhere via `.test()`).
 *     Compile failures are surfaced via `validateRules()` — the
 *     evaluator itself skips bad patterns silently.
 *
 * Each tool declares which argument fields are matchable through
 * `MATCH_FIELDS`. bash matches `command`; file ops match `path`;
 * move_file matches both `from` and `to`. Tools not listed match no
 * arguments — they ONLY fall through to `byDangerLevel`.
 */

import type { ToolDangerLevel } from "../task/tools/registry.js";
import type {
  HukoConfig,
  SafetyAction,
  ToolSafetyRules,
} from "../config/types.js";

// ─── Public types ────────────────────────────────────────────────────────────

export type PolicyDecision =
  | { action: "auto"; source: "default" | "rule"; reason?: string }
  | {
      action: "deny" | "prompt";
      source: "default" | "rule";
      reason: string;
      /** The literal pattern string from config that triggered. Optional
       *  because `byDangerLevel` decisions don't have a pattern. */
      matchedPattern?: string;
      /** Which field of the args matched (e.g. `command`). */
      matchedField?: string;
      /** The value that matched. Snippet, capped. */
      matchedValue?: string;
    };

export type EvaluatePolicyInput = {
  toolName: string;
  /** Materialised arguments the LLM passed. */
  args: Record<string, unknown>;
  /** The tool's intrinsic dangerLevel from its ServerToolDefinition. */
  dangerLevel: ToolDangerLevel;
  /** Merged `HukoConfig.safety` section (post-layered-merge). */
  safety: HukoConfig["safety"];
};

// ─── Tool → matchable argument fields ────────────────────────────────────────

/**
 * Which argument fields are subject to pattern matching, per tool.
 * Tools not listed match no fields — they fall through to byDangerLevel
 * only. Adding a tool here is a one-line change; the evaluator and
 * scaffolder both read this map.
 */
export const MATCH_FIELDS: Record<string, readonly string[]> = {
  bash: ["command", "input"],
  write_file: ["path"],
  edit_file: ["path"],
  delete_file: ["path"],
  move_file: ["from", "to"],
  read_file: ["path"],
  list_dir: ["path"],
  glob: ["path", "pattern"],
  grep: ["path", "pattern"],
  web_fetch: ["url"],
  web_search: ["query"],
};

// ─── Pattern matching ────────────────────────────────────────────────────────

const REGEX_PREFIX = "re:";

/**
 * Try to match `value` against `pattern`. Returns true on match.
 *
 *   - "re:<regex>"  → compile + test (returns false if regex is malformed)
 *   - "<literal>"   → value.startsWith(literal)
 */
export function matchPattern(value: string, pattern: string): boolean {
  if (pattern.startsWith(REGEX_PREFIX)) {
    const re = compileRegex(pattern.slice(REGEX_PREFIX.length));
    if (re === null) return false;
    return re.test(value);
  }
  return value.startsWith(pattern);
}

function compileRegex(src: string): RegExp | null {
  try {
    return new RegExp(src);
  } catch {
    return null;
  }
}

// ─── Argument value extraction ──────────────────────────────────────────────

/**
 * Pull out the string values that are subject to pattern matching for
 * this tool call. Returns `[]` if the tool has no matchable fields or
 * none of its fields contain strings.
 */
export function extractMatchableValues(
  toolName: string,
  args: Record<string, unknown>,
): Array<{ field: string; value: string }> {
  const fields = MATCH_FIELDS[toolName];
  if (!fields) return [];
  const out: Array<{ field: string; value: string }> = [];
  for (const f of fields) {
    const v = args[f];
    if (typeof v === "string" && v.length > 0) {
      out.push({ field: f, value: v });
    }
  }
  return out;
}

// ─── Rule list helper ───────────────────────────────────────────────────────

type RuleScan = {
  matched: true;
  pattern: string;
  field: string;
  value: string;
} | { matched: false };

function scanRules(
  patterns: string[] | undefined,
  values: Array<{ field: string; value: string }>,
): RuleScan {
  if (!patterns || patterns.length === 0) return { matched: false };
  for (const p of patterns) {
    for (const { field, value } of values) {
      if (matchPattern(value, p)) {
        return { matched: true, pattern: p, field, value };
      }
    }
  }
  return { matched: false };
}

// ─── Main entry ──────────────────────────────────────────────────────────────

export function evaluatePolicy(input: EvaluatePolicyInput): PolicyDecision {
  const rules: ToolSafetyRules =
    input.safety.toolRules[input.toolName] ?? {};
  const values = extractMatchableValues(input.toolName, input.args);

  // 1. deny rules — highest precedence (cannot be overridden)
  const denyHit = scanRules(rules.deny, values);
  if (denyHit.matched) {
    return {
      action: "deny",
      source: "rule",
      reason: `matched deny pattern \`${denyHit.pattern}\` on ${denyHit.field}`,
      matchedPattern: denyHit.pattern,
      matchedField: denyHit.field,
      matchedValue: truncate(denyHit.value),
    };
  }

  // 2. allow rules — auto-execute, bypassing requireConfirm + default
  const allowHit = scanRules(rules.allow, values);
  if (allowHit.matched) {
    return {
      action: "auto",
      source: "rule",
      reason: `matched allow pattern \`${allowHit.pattern}\` on ${allowHit.field}`,
    };
  }

  // 3. requireConfirm rules — prompt the operator
  const confirmHit = scanRules(rules.requireConfirm, values);
  if (confirmHit.matched) {
    return {
      action: "prompt",
      source: "rule",
      reason: `matched requireConfirm pattern \`${confirmHit.pattern}\` on ${confirmHit.field}`,
      matchedPattern: confirmHit.pattern,
      matchedField: confirmHit.field,
      matchedValue: truncate(confirmHit.value),
    };
  }

  // 4. Fallback: byDangerLevel default for this tool's intrinsic level.
  const action: SafetyAction = input.safety.byDangerLevel[input.dangerLevel];
  if (action === "auto") {
    return { action: "auto", source: "default" };
  }
  return {
    action,
    source: "default",
    reason: `dangerLevel=${input.dangerLevel} → policy ${action}`,
  };
}

// ─── Validation (called by `huko safety list` and at config load) ───────────

export type RuleValidationIssue = {
  toolName: string;
  bucket: "deny" | "allow" | "requireConfirm";
  index: number;
  pattern: string;
  problem: string;
};

/**
 * Walk every pattern in every rule list and report compile errors for
 * `re:` patterns. The evaluator already skips bad regexes silently;
 * this surfaces them for `huko safety list` so the operator notices.
 */
export function validateRules(
  toolRules: Record<string, ToolSafetyRules>,
): RuleValidationIssue[] {
  const issues: RuleValidationIssue[] = [];
  for (const [toolName, rules] of Object.entries(toolRules)) {
    for (const bucket of ["deny", "allow", "requireConfirm"] as const) {
      const list = rules[bucket];
      if (!list) continue;
      for (let i = 0; i < list.length; i++) {
        const p = list[i]!;
        if (p.startsWith(REGEX_PREFIX)) {
          if (compileRegex(p.slice(REGEX_PREFIX.length)) === null) {
            issues.push({
              toolName,
              bucket,
              index: i,
              pattern: p,
              problem: "invalid regex (will be skipped at runtime)",
            });
          }
        }
      }
    }
  }
  return issues;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function truncate(s: string, max = 200): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + "…";
}
