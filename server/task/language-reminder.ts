/**
 * server/task/language-reminder.ts
 *
 * Detect language drift in the recent context tail and produce a
 * one-shot reminder telling the LLM to stick with its working language.
 *
 * Why this exists: some models (notably Claude Opus) drift away from
 * the configured working language when a recent stretch of context is
 * dominated by content in a different script — typically because a
 * tool returned a long English file, a stack trace, etc. The static
 * `<language>` rule in the system prompt isn't always strong enough
 * to overcome that recency bias. A targeted reminder appended right
 * before the LLM call brings the model back.
 *
 * Wiring:
 *   - `detectWorkingLanguage(text)` infers a language from the very
 *     first user message at task start (cheap, no config knob).
 *   - `maybeBuildLanguageDriftReminder(messages, lang)` is called by
 *     the LLM-call pipeline. It scans the tail for cross-language
 *     imbalance and returns a reminder LLMMessage to append, or null.
 *   - The reminder is TRANSIENT — it is NOT persisted to the entry log
 *     and NOT pushed onto SessionContext.llmContext. Each call recomputes
 *     it, which means thresholds can be tuned without DB rewrites.
 *
 * Design lifted from WeavesAI's `language-reminder.ts`. Kept slim:
 *   - CJK detection by Unicode block (covers Chinese / Japanese / Korean)
 *   - Latin detection by basic A-Z range
 *   - "Working language" can be a label like "中文" / "English" / "Japanese";
 *     the classifier maps it to a script class.
 */

import type { LLMMessage } from "../core/llm/types.js";

/** How many trailing non-system messages to scan for drift. */
const SCAN_DEPTH = 8;

/** Min foreign-language char count before drift is even considered. */
const FOREIGN_THRESHOLD = 500;

/**
 * Even with high foreign count, working-language characters being
 * 1/RATIO_GATE or more of foreign means the user is intentionally
 * mixing scripts (e.g. Chinese commentary citing English code) and we
 * stay quiet.
 */
const RATIO_GATE = 10;

// ─── classifyWorkingLanguage ─────────────────────────────────────────────────

export type LanguageScript = "cjk" | "latin" | "unknown";

/**
 * Map a free-form working-language label to a coarse script class.
 * Returns "unknown" when the label is empty or unrecognised.
 */
export function classifyWorkingLanguage(
  lang: string | null | undefined,
): LanguageScript {
  if (!lang) return "unknown";
  const lower = lang.toLowerCase();
  if (
    lower.includes("中文") ||
    lower.includes("chinese") ||
    lower.includes("zh") ||
    lower.includes("简体") ||
    lower.includes("繁體") ||
    lower.includes("日本") ||
    lower.includes("japanese") ||
    lower.includes("ja") ||
    lower.includes("한국") ||
    lower.includes("korean")
  ) {
    return "cjk";
  }
  if (
    lower.includes("english") ||
    lower.includes("en") ||
    lower.includes("french") ||
    lower.includes("fr") ||
    lower.includes("german") ||
    lower.includes("de") ||
    lower.includes("spanish") ||
    lower.includes("es")
  ) {
    return "latin";
  }
  return "unknown";
}

// ─── Counting helpers ───────────────────────────────────────────────────────

export function countCjk(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (
      (c >= 0x4e00 && c <= 0x9fff) || // CJK Unified Ideographs
      (c >= 0x3040 && c <= 0x309f) || // Hiragana
      (c >= 0x30a0 && c <= 0x30ff) || // Katakana
      (c >= 0xac00 && c <= 0xd7af)    // Hangul Syllables
    ) {
      n++;
    }
  }
  return n;
}

export function countLatin(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) n++;
  }
  return n;
}

// ─── detectWorkingLanguage ───────────────────────────────────────────────────

/**
 * Decide a working-language label from the very first user message.
 *
 * Returns "中文" if CJK chars dominate, "English" if Latin chars
 * dominate, or null when the input is too short / mixed to call.
 *
 * Used by the orchestrator at task start to populate
 * `TaskContext.workingLanguage` automatically — no config knob.
 */
export function detectWorkingLanguage(firstUserText: string): string | null {
  const text = firstUserText.trim();
  if (text.length < 4) return null;

  const cjk = countCjk(text);
  const latin = countLatin(text);

  // Need at least some signal in one or the other.
  if (cjk + latin < 4) return null;

  if (cjk > latin) return "中文";
  if (latin > cjk) return "English";
  return null;
}

// ─── maybeBuildLanguageDriftReminder ────────────────────────────────────────

/**
 * Scan the tail of the conversation; if recent context is heavily
 * tilted toward the OTHER script class, return a transient reminder
 * LLMMessage. Otherwise return null.
 *
 * The returned message is meant to be appended to the messages array
 * passed to the LLM provider — NOT persisted, NOT added to
 * SessionContext's llmContext. Each LLM call recomputes the decision.
 */
export function maybeBuildLanguageDriftReminder(
  messages: LLMMessage[],
  workingLanguage: string | null,
): LLMMessage | null {
  const klass = classifyWorkingLanguage(workingLanguage);
  if (klass === "unknown") return null;
  if (messages.length === 0) return null;

  // Walk the last SCAN_DEPTH non-system messages.
  const scanned: LLMMessage[] = [];
  for (let i = messages.length - 1; i >= 0 && scanned.length < SCAN_DEPTH; i--) {
    const m = messages[i]!;
    if (m.role === "system") continue;
    scanned.push(m);
  }
  if (scanned.length === 0) return null;

  let cjk = 0;
  let latin = 0;
  for (const m of scanned) {
    const t = extractText(m);
    cjk += countCjk(t);
    latin += countLatin(t);
  }

  if (klass === "cjk") {
    // Working language CJK; foreign drift = lots of Latin content.
    if (latin < FOREIGN_THRESHOLD) return null;
    if (cjk * RATIO_GATE >= latin) return null;
  } else {
    if (cjk < FOREIGN_THRESHOLD) return null;
    if (latin * RATIO_GATE >= cjk) return null;
  }

  const body =
    klass === "cjk"
      ? `The recent context contains a large amount of English (e.g. tool output, file content, logs). Your working language is **${workingLanguage}**. CONTINUE replying in ${workingLanguage}. Tool output language MUST NOT change your response language.`
      : `The recent context contains a large amount of CJK text (e.g. tool output, file content, logs). Your working language is **${workingLanguage}**. CONTINUE replying in ${workingLanguage}. Tool output language MUST NOT change your response language.`;

  return {
    role: "user",
    content: `<system_reminder reason="language_drift">${body}</system_reminder>`,
  };
}

// ─── Internals ───────────────────────────────────────────────────────────────

function extractText(msg: LLMMessage): string {
  // huko's LLMMessage.content is currently always a string. Defensive
  // for future shapes — array-of-parts handling lifted from WeavesAI.
  if (typeof msg.content === "string") return msg.content;
  return "";
}
