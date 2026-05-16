/**
 * server/task/pipeline/context-manage.ts
 *
 * Context management — runs at the END of each TaskLoop iteration.
 *
 * Current responsibility: COMPACTION — when the in-memory LLM context
 * grows past a token threshold, drop older turns to fit the budget,
 * inject a single `<system_reminder reason="compaction_done">` carrying
 * a structured `<elided_summary>` digest so the model still sees every
 * past user goal and every past tool action.
 *
 * ============================================================
 * !!!  THE PAIRING INVARIANT — DO NOT VIOLATE                 !!!
 * ============================================================
 *
 * The actual hard constraint at the LLM-API layer is finer-grained
 * than a "turn":
 *
 *     assistant(toolCalls=[a,b,c]) MUST be immediately followed by
 *     tool(result for a), tool(result for b), tool(result for c)
 *
 * Splitting THIS group — e.g. dropping `tool(result for c)` while
 * keeping `assistant(toolCalls=[a,b,c])` — produces an invalid
 * conversation. The next API call FAILS:
 *
 *   - Anthropic returns 400 "tool_use ids in the assistant turn must
 *     each have a matching tool_result block in the next user turn"
 *   - OpenAI returns 400 "An assistant message with 'tool_calls' must
 *     be followed by tool messages responding to each 'tool_call_id'"
 *   - Gemini / DeepSeek return 400 with a similar pairing complaint
 *     (the bug WeavesAI hit — see their compaction.ts file header).
 *
 * Therefore: compaction operates on UNIT BOUNDARIES — each unit is a
 * minimal safe-to-drop slice: either a single user-role message
 * (user_message or system_reminder), or one assistant message plus all
 * its trailing tool_results. Units are never split; whole units get
 * dropped, never individual messages.
 *
 * Why finer than "user-to-user turn" matters: a single chat task often
 * has only ONE user_message followed by 30+ assistant ↔ tool_result
 * iterations. Treating that as one indivisible "turn" meant compaction
 * could never fire on browser-heavy single-prompt sessions (HukoTest
 * session 2 grew to a 156k-token prompt with --compact-threshold=0.2
 * because the turn count stayed at 2). Splitting on every assistant
 * unblocks compaction for that case while still respecting the only
 * invariant the API actually cares about (the tool_call ↔ tool_result
 * pairing inside each assistant unit).
 *
 * Tail preservation rule: the FIRST unit (always the original user
 * prompt, since the very next message is an assistant that flushes the
 * boundary) is anchored, and the LAST K units stay verbatim — K is
 * determined dynamically by the token budget walk. Only the middle
 * gets dropped.
 *
 * Elision digest — the lossy mid-band: every dropped turn contributes
 * one or more entries to `<elided_summary>`:
 *   - user_message  → verbatim (truncated at 2000 chars). User intent
 *                     is high-value and usually short; preserving the
 *                     prose means we don't need to "pin the latest user
 *                     goal" as a special case.
 *   - assistant with tool calls → one `<tool name=... />` line per call
 *                     summarising tool name + top-level arg keys
 *                     (truncated). The model sees what it did.
 *   - tool_result   → DROPPED entirely. Recoverable by re-reading the
 *                     file / re-running the command. This is where the
 *                     real space comes from.
 *   - assistant pure-reasoning, system_reminder → DROPPED. Low value
 *                     post-compaction.
 *
 * What we do NOT do (yet):
 *   - LLM-generated narrative summary (a separate cheap LLM call to
 *     produce a paragraph). Structured digest is deterministic, free,
 *     and good enough for most workloads. Add an LLM pass when a
 *     session routinely chains multiple compactions and the digest
 *     itself starts to bloat.
 *   - File-exploration de-duplication (collapse N reads of the same
 *     file into one). Future work.
 *   - Token counts from real tokenizers (we use chars/4 as a proxy).
 */

import type { LLMMessage } from "../../core/llm/types.js";
import type { TaskContext } from "../../engine/TaskContext.js";
import { EntryKind } from "../../../shared/types.js";
import { getConfig } from "../../config/index.js";

// ─── Tunables ────────────────────────────────────────────────────────────────
//
// Ratios + chars/token come from `config.compaction.*` (defaults in
// `server/config/types.ts:DEFAULT_CONFIG`). Operators tune via
// ~/.huko/config.json or <project>/.huko/config.json.
//
// Computed against `ctx.contextWindow` per call — Haiku (200k) and
// GPT-4 8k both get the same proportional treatment, no hardcoded
// absolute number. See orchestrator's `estimateContextWindow()`.

/** Max chars per user_message preserved in the digest. */
const USER_MESSAGE_DIGEST_CHAR_LIMIT = 2000;

/** Max chars per tool-argument value in the digest. */
const TOOL_ARG_DIGEST_CHAR_LIMIT = 80;

// ─── Public API ──────────────────────────────────────────────────────────────

export async function manageContext(ctx: TaskContext): Promise<void> {
  // Skip while parallel tool calls from the current assistant turn are
  // still in flight. The task loop runs one tool per iteration; sibling
  // calls from the same assistant message wait in `deferredCalls`. If
  // we elide that assistant entry now, the late-arriving siblings'
  // tool_results land AFTER the compaction reminder with no matching
  // tool_call in scope — `loadLLMContext` can't pair them on rehydrate
  // and strict APIs (DeepSeek) reject the orphan with HTTP 400.
  if (ctx.deferredCalls.length > 0) return;

  const sc = ctx.sessionContext;
  const cfg = getConfig().compaction;
  const messages = sc.getMessages();
  const totalTokens = approxTokensOfMessages(messages, cfg.charsPerToken);

  // Scale thresholds to this model's context window.
  const threshold = Math.ceil(ctx.contextWindow * cfg.thresholdRatio);
  const target = Math.ceil(ctx.contextWindow * cfg.targetRatio);

  if (totalTokens < threshold) return;

  const turns = groupIntoTurns(messages, cfg.charsPerToken);

  // Need at least three units: [first][...middle...][last]. With < 3
  // units there's nothing in the middle to drop; the first unit is the
  // original user prompt (always preserved) and the last is the most
  // recent activity.
  if (turns.length < 3) return;

  const plan = pickTurnsToKeep(turns, target);
  if (plan.dropped === 0) return;

  // The slice we're dropping = turns[1 .. turns.length - tail.length).
  const droppedTurns = turns.slice(1, turns.length - plan.tailTurns.length);

  // Collect the entryIds of every dropped message — stored in the
  // reminder's metadata so future session-continue / resume code can
  // know to filter them out when re-hydrating llmContext from the
  // persistent log. Without this, a follow-up `huko --session=N`
  // on the same session would re-load all the elided rows AND see the
  // "N turns elided" marker — self-contradictory and re-blows the
  // context window.
  //
  // Pre-recording the IDs on the WRITE side now (cheap) means the
  // future READ-side filter doesn't need any schema migration — it
  // just scans for compaction_done reminders and reads their metadata.
  const elidedEntryIds: number[] = [];
  for (const t of droppedTurns) {
    for (const m of t.messages) {
      if (typeof m._entryId === "number") elidedEntryIds.push(m._entryId);
    }
  }

  // Build the structured digest from the dropped turns. The digest is
  // what makes "drop the middle band" non-lossy in the dimensions that
  // matter: every past user goal stays visible (so the model knows the
  // current objective even if the latest user turn is no longer
  // verbatim in context), and every past tool call stays visible (so
  // the model knows what work it already did and doesn't redo it).
  const digest = buildElidedDigest(droppedTurns);

  // Persist a single reminder so both the LLM and the persistent log
  // know history was trimmed. The reminder lands at the END of llmContext
  // (appendReminder pushes via append). We capture it, then rebuild
  // llmContext as: [first turn] + [reminder] + [tail turns].
  const summary =
    `${plan.dropped} earlier turn(s) (~${plan.droppedTokens} tokens) ` +
    `elided to fit the context window. Tool results were dropped — ` +
    `re-read files or re-run commands if you need ground-truth state. ` +
    `Your CURRENT objective is the most recent user_message — either ` +
    `in the digest below or in the conversation that follows.`;
  const reminderContent = digest.length > 0 ? `${digest}\n\n${summary}` : summary;

  await sc.appendReminder({
    taskId: ctx.taskId,
    reason: "compaction_done",
    content: reminderContent,
    extraMetadata: {
      elidedEntryIds,
      elidedTurnCount: plan.dropped,
      elidedApproxTokens: plan.droppedTokens,
    },
  });

  // Pull the reminder we just appended (it was added to the end).
  const afterAppend = sc.getMessages();
  const reminderMsg = afterAppend[afterAppend.length - 1];
  if (!reminderMsg) return; // defensive — shouldn't happen

  const composed: LLMMessage[] = [
    ...plan.firstTurn.messages,
    reminderMsg,
    ...plan.tailTurns.flatMap((t) => t.messages),
  ];

  sc.replaceContext(composed);
}

// ─── Elision digest ──────────────────────────────────────────────────────────

/**
 * Build the `<elided_summary>` block from the dropped turns.
 *
 * Walks every message in every dropped turn, emitting one line per
 * goal-or-action-bearing message:
 *
 *   - UserMessage   → `<user_message>...</user_message>` (verbatim,
 *                     truncated at USER_MESSAGE_DIGEST_CHAR_LIMIT).
 *   - AiMessage with toolCalls → one `<tool name="...">k=v k=v</tool>`
 *                     line per call, args truncated.
 *   - everything else → dropped.
 *
 * Returns "" if there's nothing worth digesting (e.g. the dropped
 * region was all tool_results and reasoning), in which case the caller
 * skips the `<elided_summary>` wrapper entirely.
 *
 * Exported for tests.
 */
export function buildElidedDigest(droppedTurns: Turn[]): string {
  const lines: string[] = [];
  for (const t of droppedTurns) {
    for (const m of t.messages) {
      const k = m._entryKind;
      if (k === EntryKind.UserMessage) {
        const body = truncate(m.content, USER_MESSAGE_DIGEST_CHAR_LIMIT);
        lines.push(`<user_message>${xmlEscape(body)}</user_message>`);
      } else if (k === EntryKind.AiMessage && m.toolCalls && m.toolCalls.length > 0) {
        for (const tc of m.toolCalls) {
          const args = summariseToolArgs(tc.arguments);
          lines.push(
            args.length > 0
              ? `<tool name="${xmlEscape(tc.name)}">${args}</tool>`
              : `<tool name="${xmlEscape(tc.name)}"/>`,
          );
        }
      }
      // ToolResult, SystemReminder, AiMessage-without-toolCalls → skip
    }
  }
  if (lines.length === 0) return "";
  return ["<elided_summary>", ...lines, "</elided_summary>"].join("\n");
}

/**
 * Render a tool call's top-level arguments as a `k=v k=v` blob,
 * truncating each value at TOOL_ARG_DIGEST_CHAR_LIMIT. Nested objects
 * get `JSON.stringify`'d before truncation.
 */
function summariseToolArgs(args: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(args)) {
    let str: string;
    if (typeof v === "string") str = v;
    else {
      try {
        str = JSON.stringify(v);
      } catch {
        str = String(v);
      }
    }
    parts.push(`${k}=${xmlEscape(truncate(str, TOOL_ARG_DIGEST_CHAR_LIMIT))}`);
  }
  return parts.join(" ");
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ─── Turn grouping ───────────────────────────────────────────────────────────

export type Turn = {
  messages: LLMMessage[];
  approxTokens: number;
};

/**
 * Group messages into compaction units. A new unit STARTS at either:
 *
 *   - `role: "user"`       — real user message OR system_reminder
 *                            (both carry role "user" in our schema)
 *   - `role: "assistant"`  — every assistant message starts its own
 *                            unit, so tool_results stay attached only
 *                            to their producing assistant.
 *
 * Following `role: "tool"` messages glue onto the unit that started
 * the current group. That keeps each assistant + its matching
 * tool_results atomic (the pairing invariant — see file header).
 *
 * Why split on every assistant: see the file-header rationale. The
 * coarse "user-to-user" turn boundary made compaction a no-op on
 * heavy single-prompt sessions (one user message, 30+ assistant
 * iterations = 1 turn = nothing to drop). Splitting on every
 * assistant lets the middle assistant↔tool groups become droppable.
 *
 * Exported for tests so the unit-grouping logic can be exercised
 * directly without spinning up a TaskContext.
 *
 * Edge case: leading non-user / non-assistant messages (shouldn't
 * happen in normal flow, but defensively handled) form a synthetic
 * first unit.
 */
export function groupIntoTurns(
  messages: LLMMessage[],
  charsPerToken: number,
): Turn[] {
  const turns: Turn[] = [];
  let current: LLMMessage[] = [];

  const flush = (): void => {
    if (current.length === 0) return;
    turns.push({
      messages: current,
      approxTokens: approxTokensOfMessages(current, charsPerToken),
    });
    current = [];
  };

  for (const m of messages) {
    if (m.role === "user" || m.role === "assistant") {
      flush();
      current = [m];
    } else {
      // role: "tool" — glue onto the current (assistant-led) unit.
      current.push(m);
    }
  }
  flush();

  return turns;
}

// ─── Pick which turns to keep ────────────────────────────────────────────────

type CompactionPlan = {
  firstTurn: Turn;
  tailTurns: Turn[];
  dropped: number;
  droppedTokens: number;
};

/**
 * Decide which units survive the compaction.
 *
 * Rules:
 *   1. ALWAYS keep the first unit — under the new sub-turn grouping
 *      this is the original user_message alone (since the next
 *      message is an assistant that flushes the boundary). Losing it
 *      makes the rest of the conversation incoherent.
 *   2. Walk backwards from the end, pulling units into the tail until
 *      the budget runs out.
 *   3. Whatever's between the first unit and the tail gets dropped
 *      atomically (whole units, never partial — each assistant unit
 *      keeps its tool_results), and gets summarised into
 *      `<elided_summary>` by buildElidedDigest.
 *
 * No "pin latest user goal" special case — the digest preserves every
 * past user_message verbatim (truncated at 2k chars), so the model
 * sees the full goal trail without us teaching the planner about user
 * intent specifically. Treating all elided turns uniformly keeps the
 * planner principled.
 *
 * If the tail walk would consume the second turn (so dropped === 0),
 * we report that and the caller skips compaction.
 */
function pickTurnsToKeep(turns: Turn[], budget: number): CompactionPlan {
  const firstTurn = turns[0]!;
  const tailTurns: Turn[] = [];
  let used = firstTurn.approxTokens;

  for (let i = turns.length - 1; i >= 1; i--) {
    const t = turns[i]!;
    if (used + t.approxTokens > budget) break;
    tailTurns.unshift(t);
    used += t.approxTokens;
  }

  // Dropped = turns[1 .. (turns.length - tailTurns.length - 1)]
  const droppedCount = turns.length - 1 - tailTurns.length;
  const droppedTokens = turns
    .slice(1, turns.length - tailTurns.length)
    .reduce((s, t) => s + t.approxTokens, 0);

  return {
    firstTurn,
    tailTurns,
    dropped: droppedCount,
    droppedTokens,
  };
}

// ─── Token estimation ────────────────────────────────────────────────────────

function approxTokensOfMessage(m: LLMMessage, charsPerToken: number): number {
  let chars = m.content.length;
  if (m.thinking) chars += m.thinking.length;
  if (m.toolCalls) {
    for (const tc of m.toolCalls) {
      chars += tc.name.length;
      try {
        chars += JSON.stringify(tc.arguments).length;
      } catch {
        chars += 32; // rough fallback
      }
    }
  }
  // Per-message overhead (role, framing).
  return Math.ceil(chars / charsPerToken) + 8;
}

function approxTokensOfMessages(messages: LLMMessage[], charsPerToken: number): number {
  let sum = 0;
  for (const m of messages) sum += approxTokensOfMessage(m, charsPerToken);
  return sum;
}
