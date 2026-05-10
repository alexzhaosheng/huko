/**
 * Tool: message
 *
 * The single channel for the assistant to talk to the user.
 *
 * Modes:
 *   - `info`   — progress updates / acknowledgements; no break
 *   - `ask`    — block until user replies; reply text is the tool result
 *   - `result` — final deliverable; sets ctx.finalResult and ends the task
 *
 * `ask` mode requires the orchestrator to have wired
 * `TaskContext.waitForReply`. When the user runs `huko run --no-interaction`,
 * the registry materialises this tool's schema WITHOUT `ask` — the LLM
 * literally can't request user input.
 *
 * v1 doesn't accept attachments yet. Once the file/fs tools land we can
 * revisit and add an `attachments: string[]` parameter.
 *
 * Description copy mirrors WeavesAI's, trimmed and adjusted to huko's
 * three modes. (See `WeavesAI/server/task/tools/server/message.ts`.)
 */

import {
  registerServerTool,
  type ToolHandlerResult,
  type ToolMaterializeContext,
} from "../registry.js";
import type { TaskContext } from "../../../engine/TaskContext.js";

type MessageToolType = "info" | "ask" | "result";

const BASE_DESCRIPTION =
  "Send messages to interact with the user.\n\n" +
  "<supported_types>\n" +
  "- `info`: Inform the user with acknowledgement or progress updates without requiring a response\n" +
  "- `ask`: Ask the user a question and BLOCK until they reply; the reply is returned as the tool result\n" +
  "- `result`: Deliver the final result to the user and end the task\n" +
  "</supported_types>\n\n" +
  "<instructions>\n" +
  "- MUST use this tool for any communication with the user instead of plain assistant text\n" +
  "- NEVER provide direct answers without proper reasoning or prior analysis\n" +
  "- Actively use `info` to provide progress updates; no reply is needed from the user\n" +
  "- Use `ask` when you genuinely lack information needed to proceed and the user is the only source. Prefer reading files or running tools first; ask is a last resort.\n" +
  "- Use `ask` with `options` when the answer is one of a small known set; this lets the UI render a clean choice picker\n" +
  "- MUST use `result` to present the final deliverable at the end of the task\n" +
  "- The task ends after a `result` message; the user may ask follow-ups in a new turn\n" +
  "- Use `result` to respond when the user's message only requires a reply (e.g., simple chat or follow-up questions)\n" +
  "- When the user explicitly requests to end the task, MUST immediately use `result` to acknowledge and end\n" +
  "- MUST ensure the work has reached the final phase before sending `result`, unless the user explicitly requests to stop\n" +
  "- DO NOT send multiple consecutive `info` messages while waiting for missing information — use `ask` instead\n" +
  "</instructions>\n\n" +
  "<recommended_usage>\n" +
  "- Use `info` to acknowledge initial user messages and confirm task start\n" +
  "- Use `info` to notify the user of progress checkpoints or decisions made\n" +
  "- Use `ask` when a critical decision genuinely requires the user's input\n" +
  "- Use `result` to deliver the final answer at the end of the task\n" +
  "- Use `result` for simple chat replies or follow-up questions that need no further actions\n" +
  "- Use `result` to end the task when the user explicitly requests it\n" +
  "</recommended_usage>";

const NON_INTERACTIVE_NOTE =
  "<non_interactive_mode>\n" +
  "This task is running non-interactively — the `ask` type is NOT available. Make decisions yourself based on available context, or use `result` to surface a question for the next turn instead of trying to ask in-task.\n" +
  "</non_interactive_mode>";

/** Schema generator — drops `ask` from the type enum when interactive=false. */
function buildSchema(ctx: ToolMaterializeContext) {
  const types: MessageToolType[] = ctx.interactive
    ? ["info", "ask", "result"]
    : ["info", "result"];
  return {
    type: "object" as const,
    properties: {
      type: {
        type: "string" as const,
        enum: types,
        description: "The kind of message to send",
      },
      text: {
        type: "string" as const,
        description: "The message body / question / final-result text",
      },
      options: {
        type: "array" as const,
        items: { type: "string" as const },
        description:
          "Predefined choices (only for type=ask). When set, the UI renders a picker; the user's reply is one of (or a subset of) these strings.",
      },
      selectionType: {
        type: "string" as const,
        enum: ["single", "multiple"],
        description:
          "Only for type=ask with options: 'single' = pick one (radio), 'multiple' = pick zero or more (checkboxes). Default 'single'.",
      },
    },
    required: ["type", "text"],
  };
}

registerServerTool(
  {
    name: "message",
    description: BASE_DESCRIPTION,
    parameters: buildSchema({ interactive: true }),
    parametersFor: (ctx) => buildSchema(ctx),
    descriptionFor: (ctx) => (ctx.interactive ? undefined : NON_INTERACTIVE_NOTE),
    dangerLevel: "safe",
  },
  async (args, ctx, callMeta): Promise<ToolHandlerResult> => {
    const rawType = String(args["type"] ?? "info");
    const msgType: MessageToolType =
      rawType === "result"
        ? "result"
        : rawType === "ask"
          ? "ask"
          : "info";
    const msgText = String(args["text"] ?? "");

    if (msgType === "result") {
      return {
        content: "Message sent to user.",
        shouldBreak: true,
        finalResult: msgText,
        summary: `message(type=result)`,
      };
    }

    if (msgType === "ask") {
      return await handleAsk(args, ctx, callMeta?.toolCallId, msgText);
    }

    // info — fire and forget; no break
    return {
      content: "Message sent to user.",
      summary: `message(type=info)`,
      metadata: { messageType: "info", text: msgText },
    };
  },
);

async function handleAsk(
  args: Record<string, unknown>,
  ctx: TaskContext,
  toolCallId: string | undefined,
  question: string,
): Promise<ToolHandlerResult> {
  // Defensive: this branch shouldn't be reachable when interactive=false
  // (the schema doesn't even include "ask"), but the LLM is what it is.
  if (!ctx.waitForReply) {
    return {
      content:
        "Error: ask is not available in this task — no waitForReply callback wired. " +
        "Either run without --no-interaction, or fall back to `result` and let the user follow up.",
      error: "no_wait_for_reply",
      summary: "message(type=ask) refused (non-interactive)",
    };
  }
  if (!toolCallId) {
    // Should never happen — every tool call has an id — but be defensive.
    return {
      content: "Error: ask requires a tool call id but none was provided.",
      error: "missing_tool_call_id",
      summary: "message(type=ask) refused (no id)",
    };
  }

  const optionsRaw = args["options"];
  const options =
    Array.isArray(optionsRaw)
      ? optionsRaw.filter((o): o is string => typeof o === "string")
      : undefined;
  const selectionRaw = args["selectionType"];
  const selectionType: "single" | "multiple" | undefined =
    selectionRaw === "multiple" || selectionRaw === "single" ? selectionRaw : undefined;

  const reply = await ctx.waitForReply({
    toolCallId,
    question,
    ...(options && options.length > 0 ? { options } : {}),
    ...(selectionType !== undefined ? { selectionType } : {}),
  });

  return {
    content: reply.content || "(empty reply)",
    summary: `message(type=ask) → reply (${reply.content.length} chars)`,
    metadata: {
      messageType: "ask",
      question,
      ...(options && options.length > 0 ? { options } : {}),
      ...(selectionType !== undefined ? { selectionType } : {}),
      replyContent: reply.content,
      ...(reply.attachments && reply.attachments.length > 0
        ? { replyAttachments: reply.attachments }
        : {}),
    },
  };
}
