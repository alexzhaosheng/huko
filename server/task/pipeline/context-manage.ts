/**
 * server/task/pipeline/context-manage.ts
 *
 * Context management — runs at the END of each TaskLoop iteration.
 *
 * Current responsibility: COMPACTION — when the in-memory LLM context
 * grows past a token threshold, drop older turns to fit the budget,
 * inject a single `<system_reminder reason="compaction_done">` so the
 * model knows history was trimmed.
 *
 * ============================================================
 * !!!  THE TURN-ATOMIC INVARIANT — DO NOT VIOLATE             !!!
 * ============================================================
 *
 * A "turn" is a contiguous group of LLMMessages that MUST stay
 * together as a unit. Specifically:
 *
 *     user(text) → assistant(content + maybe toolCalls)
 *                → tool(result for tc1)
 *                → tool(result for tc2)
 *                → ...
 *
 * Splitting a turn — e.g. dropping `tool(result for tc2)` while
 * keeping `assistant(toolCalls=[tc1,tc2])` — produces an invalid
 * conversation. The next API call FAILS:
 *
 *   - Anthropic returns 400 "tool_use ids in the assistant turn must
 *     each have a matching tool_result block in the next user turn"
 *   - OpenAI returns 400 "An assistant message with 'tool_calls' must
 *     be followed by tool messages responding to each 'tool_call_id'"
 *   - Gemini returns 400 with a similar pairing complaint (this is
 *     the bug WeavesAI hit — see their compaction.ts file header).
 *
 * Therefore: compaction operates on TURN BOUNDARIES, never on
 * individual messages. We group, we drop whole turns, we never split.
 *
 * Tail preservation rule: the most recent N turns stay verbatim. The
 * model needs continuity to make sense of "where was I?". Only OLD
 * turns get dropped; only the FIRST turn (the original user request)
 * is anchored as the long-tail keep.
 *
 * What we do NOT do (yet):
 *   - LLM-summary path (replace dropped turns with a generated digest).
 *     Cheaper and good enough for v1 to just say "N earlier turns
 *     elided" via system_reminder. Add LLM summary when sessions
 *     routinely outlast simple compaction.
 *   - File-exploration digest (collapse long file-read chains).
 *   - Token counts from real tokenizers (we use chars/4 as a proxy).
 */

import type { LLMMessage } from "../../core/llm/types.js";
import type { TaskContext } from "../../engine/TaskContext.js";
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

// ─── Public API ──────────────────────────────────────────────────────────────

export async function manageContext(ctx: TaskContext): Promise<void> {
  const sc = ctx.sessionContext;
  const cfg = getConfig().compaction;
  const messages = sc.getMessages();
  const totalTokens = approxTokensOfMessages(messages, cfg.charsPerToken);

  // Scale thresholds to this model's context window.
  const threshold = Math.ceil(ctx.contextWindow * cfg.thresholdRatio);
  const target = Math.ceil(ctx.contextWindow * cfg.targetRatio);

  if (totalTokens < threshold) return;

  const turns = groupIntoTurns(messages, cfg.charsPerToken);

  // Need at least three turns: [first][...middle...][last]. With ≤ 2
  // turns there's nothing safe to drop (we'd risk dropping the only
  // user request or an in-flight assistant→tool pair).
  if (turns.length <= 2) return;

  const plan = pickTurnsToKeep(turns, target);
  if (plan.dropped === 0) return;

  // Collect the entryIds of every dropped message — stored in the
  // reminder's metadata so future session-continue / resume code can
  // know to filter them out when re-hydrating llmContext from the
  // persistent log. Without this, a follow-up `huko run --session=N`
  // on the same session would re-load all the elided rows AND see the
  // "N turns elided" marker — self-contradictory and re-blows the
  // context window.
  //
  // Pre-recording the IDs on the WRITE side now (cheap) means the
  // future READ-side filter doesn't need any schema migration — it
  // just scans for compaction_done reminders and reads their metadata.
  const elidedEntryIds: number[] = [];
  for (const t of turns.slice(1, turns.length - plan.tailTurns.length)) {
    for (const m of t.messages) {
      if (typeof m._entryId === "number") elidedEntryIds.push(m._entryId);
    }
  }

  // Persist a single reminder so both the LLM and the persistent log
  // know history was trimmed. The reminder lands at the END of llmContext
  // (appendReminder pushes via append). We capture it, then rebuild
  // llmContext as: [first turn] + [reminder] + [tail turns].
  await sc.appendReminder({
    taskId: ctx.taskId,
    reason: "compaction_done",
    content:
      `Context window was trimmed: ${plan.dropped} earlier turn(s) ` +
      `(approximately ${plan.droppedTokens} tokens) elided from this LLM call. ` +
      `Full history remains in the persistent log; the in-memory view drops ` +
      `older turns to stay under the model's context budget. ` +
      `Continue from the most recent state.`,
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

// ─── Turn grouping ───────────────────────────────────────────────────────────

type Turn = {
  messages: LLMMessage[];
  approxTokens: number;
};

/**
 * Group messages into turns. A turn STARTS at a `role: "user"` message
 * (real user message OR a system_reminder, both of which carry role
 * "user" in our schema). Following assistant + tool messages glue
 * onto that turn until the next `role: "user"`.
 *
 * Edge case: leading non-user messages (shouldn't happen in normal
 * flow, but defensively handled) form a synthetic first turn.
 */
function groupIntoTurns(messages: LLMMessage[], charsPerToken: number): Turn[] {
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
    if (m.role === "user") {
      flush();
      current = [m];
    } else {
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
 * Decide which turns survive the compaction.
 *
 * Rules:
 *   1. ALWAYS keep the first turn — it's the original user request,
 *      losing it makes the rest of the conversation incoherent.
 *   2. Walk backwards from the end, pulling turns into the tail until
 *      the budget runs out.
 *   3. Whatever's between the first turn and the tail gets dropped
 *      atomically (whole turns, never partial).
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
