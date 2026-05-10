/**
 * server/task/behavior-guard.ts
 *
 * Per-task behaviour tracker. Watches the LLM's tool-use pattern and
 * returns text reminders when it spots one of the known anti-patterns.
 *
 * Today the guard tracks two patterns:
 *
 *   1. Consecutive `message(type=info)` — info messages don't gather a
 *      response, so a chain of them usually means the LLM is "thinking
 *      out loud" instead of taking action. After 3 in a row, nudge it
 *      to run a real tool, ask a question, or deliver a result.
 *
 *   2. Consecutive empty turns — the LLM produced neither a tool call
 *      nor any final text. The first time we say so politely; persistent
 *      offenders get the stronger "[Tool Use Enforcement]" wording
 *      WeavesAI uses.
 *
 * Counters reset on:
 *   - any tool execution (for `consecutiveInfoCount`, except message tool)
 *   - any non-empty turn (for `consecutiveEmptyCount`)
 *   - user interjection (both — handled by `resetOnUserInteraction`)
 *
 * Why an instance rather than module-globals: the orchestrator can host
 * many concurrent tasks (per-session). State has to be per-task.
 */

// ─── Reminder text builders ──────────────────────────────────────────────────

const INFO_ACK =
  "You have proactively sent an `info` type message to the user. " +
  "By design, `info` messages are used to inform the user and continue task execution without requiring a response. " +
  "If this is the intended behavior, proceed with the task; otherwise, use `ask` type to wait for a user reply, or `result` type if the task is complete.";

function consecutiveInfoText(count: number): string {
  return (
    `You have sent ${count} consecutive info messages without executing any other tool. ` +
    `Stop sending info messages and take action: execute a tool to make progress, ` +
    `use \`message(type=ask)\` if you need user input, or use \`message(type=result)\` to deliver final results.`
  );
}

const EMPTY_TURN_GENTLE =
  "Your previous turn was empty. Either call a tool or reply to the user with a final answer.";

const EMPTY_TURN_STRONG =
  "[Tool Use Enforcement] Your previous response contained text but no tool call, and no final answer. " +
  "Text responses without a tool call are not executed or delivered — you MUST call a tool to proceed, " +
  "or use `message(type=result)` to deliver a final answer.";

// ─── Tunables ────────────────────────────────────────────────────────────────

/** How many `message(type=info)` calls in a row before we fire the stronger nudge. */
const CONSECUTIVE_INFO_LIMIT = 3;

/** Empty-turn count at which we escalate to the strong reminder. */
const EMPTY_TURN_ESCALATE_AT = 2;

// ─── Public reminder shape ───────────────────────────────────────────────────

/**
 * Reminders the guard emits. Same shape as `PostReminder` in the tool
 * registry — re-declared here so this module stays free of registry
 * imports (tests can build it without spinning up the tool registry).
 */
export type GuardReminder = {
  reason: string;
  content: string;
};

// ─── BehaviorGuard ───────────────────────────────────────────────────────────

export class BehaviorGuard {
  private consecutiveInfoCount = 0;
  private consecutiveEmptyCount = 0;

  /**
   * Called by tool-execute.ts AFTER every tool runs (success or error).
   * Returns reminders to inject after the tool_result.
   */
  afterToolExecution(
    toolName: string,
    args: Record<string, unknown>,
    _isError: boolean,
  ): GuardReminder[] {
    const reminders: GuardReminder[] = [];

    if (toolName === "message") {
      const msgType = String(args["type"] ?? "info");
      if (msgType === "info") {
        this.consecutiveInfoCount += 1;
        // First info ack always fires.
        reminders.push({ reason: "message_info_ack", content: INFO_ACK });
        if (this.consecutiveInfoCount >= CONSECUTIVE_INFO_LIMIT) {
          reminders.push({
            reason: "message_info_chain",
            content: consecutiveInfoText(this.consecutiveInfoCount),
          });
        }
      } else {
        // ask / result — counter resets
        this.consecutiveInfoCount = 0;
      }
    } else {
      this.consecutiveInfoCount = 0;
    }

    return reminders;
  }

  /**
   * Called by task-loop.ts when the LLM produces a turn with no tool
   * calls and no content. Returns the reminder to append.
   *
   * The retry budget itself stays in task-loop.ts (it's also tied to
   * config); this method just produces the right text + reason.
   */
  onEmptyTurn(): GuardReminder {
    this.consecutiveEmptyCount += 1;
    if (this.consecutiveEmptyCount >= EMPTY_TURN_ESCALATE_AT) {
      return { reason: "empty_turn_persistent", content: EMPTY_TURN_STRONG };
    }
    return { reason: "empty_turn", content: EMPTY_TURN_GENTLE };
  }

  /** Called when a real (non-empty) LLM turn lands. */
  onProductiveTurn(): void {
    this.consecutiveEmptyCount = 0;
  }

  /** Called when the user sends a new message (interjection). */
  resetOnUserInteraction(): void {
    this.consecutiveInfoCount = 0;
    this.consecutiveEmptyCount = 0;
  }

  // ── Diagnostics (test-only) ────────────────────────────────────────────────

  get _infoCount(): number {
    return this.consecutiveInfoCount;
  }
  get _emptyCount(): number {
    return this.consecutiveEmptyCount;
  }
}
