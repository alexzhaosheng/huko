/**
 * Tool: message
 *
 * The single channel for the assistant to speak to the user.
 *
 * v1 supports two modes:
 *   - `info`   — progress updates / acknowledgements; no break
 *   - `result` — final deliverable; sets ctx.finalResult and ends the task
 *
 * The `ask` mode (block until user replies) is intentionally deferred —
 * it depends on the engine's waitForReply plumbing which lands later.
 *
 * v1 also does not accept attachments. Once the file / fs tools land
 * we can revisit and add an `attachments: string[]` parameter
 * mirroring WeavesAI's shape.
 *
 * Description copy mostly mirrors WeavesAI's, trimmed to the two
 * supported modes. (See `WeavesAI/server/task/tools/server/message.ts`.)
 */

import { registerServerTool, type ToolHandlerResult } from "../registry.js";

type MessageToolType = "info" | "result";

const MESSAGE_DESCRIPTION =
  "Send messages to interact with the user.\n\n" +
  "<supported_types>\n" +
  "- `info`: Inform the user with acknowledgement or progress updates without requiring a response\n" +
  "- `result`: Deliver the final result to the user and end the task\n" +
  "</supported_types>\n\n" +
  "<instructions>\n" +
  "- MUST use this tool for any communication with the user instead of plain assistant text\n" +
  "- NEVER provide direct answers without proper reasoning or prior analysis\n" +
  "- Actively use `info` to provide progress updates; no reply is needed from the user\n" +
  "- MUST use `result` to present the final deliverable at the end of the task\n" +
  "- The task ends after a `result` message; the user may ask follow-ups in a new turn\n" +
  "- Use `result` to respond when the user's message only requires a reply (e.g., simple chat or follow-up questions)\n" +
  "- When the user explicitly requests to end the task, MUST immediately use `result` to acknowledge and end\n" +
  "- MUST ensure the work has reached the final phase before sending `result`, unless the user explicitly requests to stop\n" +
  "- DO NOT send multiple consecutive `info` messages while waiting for missing information\n" +
  "</instructions>\n\n" +
  "<recommended_usage>\n" +
  "- Use `info` to acknowledge initial user messages and confirm task start\n" +
  "- Use `info` to notify the user of progress checkpoints or decisions made\n" +
  "- Use `result` to deliver the final answer at the end of the task\n" +
  "- Use `result` for simple chat replies or follow-up questions that need no further actions\n" +
  "- Use `result` to end the task when the user explicitly requests it\n" +
  "</recommended_usage>";

registerServerTool(
  {
    name: "message",
    description: MESSAGE_DESCRIPTION,
    parameters: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: ["info", "result"],
          description: "The type of the message",
        },
        text: {
          type: "string",
          description: "The message or final-result text to be shown to the user",
        },
      },
      required: ["type", "text"],
    },
    dangerLevel: "safe",
    display: {
      compactTemplate: '<message type="{msgType}">{textShort}</message>',
      extractParams: (args) => {
        const msgType = String(args.type ?? "info");
        const text = String(args.text ?? "");
        return { msgType, text, textShort: text.slice(0, 80) };
      },
    },
  },
  async (args): Promise<ToolHandlerResult> => {
    const rawType = String(args["type"] ?? "info");
    const msgType: MessageToolType =
      rawType === "result" ? "result" : "info";
    const msgText = String(args["text"] ?? "");

    if (msgType === "result") {
      return {
        content: "Message sent to user.",
        shouldBreak: true,
        finalResult: msgText,
        summary: `message(type=result)`,
      };
    }

    // info — fire and forget; no break
    return {
      content: "Message sent to user.",
      summary: `message(type=info)`,
      metadata: { messageType: "info", text: msgText },
    };
  },
);
