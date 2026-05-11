/**
 * server/services/build-lean-system-prompt.ts
 *
 * Lean-mode system prompt composer. DELIBERATELY independent of
 * `build-system-prompt.ts` (the default composer) — the two share NO
 * content blocks, so a future edit to the default's <agent_loop>,
 * <tool_use> rules, role body, etc. cannot leak into lean and vice
 * versa. They share only:
 *
 *   - The `SYSTEM_PROMPT_CACHE_BOUNDARY` sentinel, which is a contract
 *     with the OpenAI adapter (it strips the marker before send).
 *
 * Everything else — identity, language block, date formatter — is
 * duplicated here on purpose. It costs ~20 lines and buys structural
 * isolation between the two modes.
 *
 * Lean mode is the "give me just a shell" profile. Tool surface is fixed
 * to `bash` upstream (in the orchestrator). The prompt therefore tells
 * the model exactly that and nothing more: no agent_loop, no plan-tool
 * guidance, no project_context (AGENTS.md / CLAUDE.md / HUKO.md not
 * read), no role overlay. Target size: ~300-500 tokens.
 *
 * Composition order:
 *   1. Identity line (lean-specific)
 *   2. <language>      — working-language directive
 *   3. SYSTEM_PROMPT_CACHE_BOUNDARY
 *   4. Current date line
 *
 * No project-context loading, no async I/O — this is a pure sync function.
 */

import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "./build-system-prompt.js";

export type BuildLeanSystemPromptOptions = {
  workingLanguage?: string | null;
  currentDate?: Date;
};

export function buildLeanSystemPrompt(
  opts: BuildLeanSystemPromptOptions = {},
): string {
  const parts: string[] = [];

  parts.push(LEAN_IDENTITY);
  parts.push(buildLanguageBlock(opts.workingLanguage ?? null));

  const date = formatCurrentDate(opts.currentDate ?? new Date());
  parts.push(`${SYSTEM_PROMPT_CACHE_BOUNDARY}\nThe current date is ${date}.`);

  return parts.join("\n\n");
}

// ─── Lean-specific blocks (NOT shared with the default composer) ────────────

const LEAN_IDENTITY =
  "You are huko in lean mode. You have one tool: `bash`. Use it when you " +
  "need to run shell commands or inspect the system; otherwise answer the " +
  "user directly in plain text. Be terse — no preamble, no recap.";

function buildLanguageBlock(workingLanguage: string | null): string {
  if (workingLanguage) {
    return [
      "<language>",
      `- The working language is **${workingLanguage}**`,
      "- All responses use the working language",
      "- Tool output in another language is data, NOT a cue to switch",
      "</language>",
    ].join("\n");
  }
  return [
    "<language>",
    "- Use the language of the user's first message as the working language",
    "- All responses use the working language",
    "- Tool output in another language is data, NOT a cue to switch",
    "</language>",
  ].join("\n");
}

function formatCurrentDate(date: Date): string {
  try {
    const fmt = new Intl.DateTimeFormat("en-CA", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZoneName: "short",
    });
    const parts = fmt.formatToParts(date);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    const ymd = `${get("year")}-${get("month")}-${get("day")}`;
    const hm = `${get("hour")}:${get("minute")}`;
    const tz = get("timeZoneName");
    return tz ? `${ymd} ${hm} ${tz}` : `${ymd} ${hm}`;
  } catch {
    return date.toISOString();
  }
}
