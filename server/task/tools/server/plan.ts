/**
 * Tool: plan
 *
 * Two actions: update / advance. PlanState lives on TaskContext.planState
 * (in memory). Each call emits PlanEvent(s) into tool_result metadata —
 * the only persisted record. On resume, replay events to rebuild state.
 *
 * Best-practices injection: on every transition that activates a phase
 * (initial via update, next via advance), look up role bodies for each
 * capability and append them to the tool result.
 *
 * Post-update reminder: after `update`, queue a system_reminder
 * reinforcing "if user changes scope, plan(update) again first".
 */

import {
  registerServerTool,
  type PostReminder,
  type ToolHandlerResult,
} from "../registry.js";
import type { TaskContext } from "../../../engine/TaskContext.js";
import {
  applyPlanEvent,
  formatPlan,
} from "../../plan-state.js";
import type {
  PlanEvent,
  PlanEventAdvance,
  PlanEventUpdate,
} from "../../../../shared/plan-types.js";
import { buildBestPracticesInjection } from "../../best-practices.js";

// ─── description ─────────────────────────────────────────────────────────────

const PLAN_DESCRIPTION =
  "Create, update, and advance the structured task plan.\n\n" +
  "<supported_actions>\n" +
  "- `update`: Create or revise the current task plan based on user input or newly discovered information\n" +
  "- `advance`: Move to the next phase in the existing plan when the current phase has been fully completed\n" +
  "</supported_actions>\n\n" +
  "<instructions>\n" +
  "- Use this tool to plan tasks and break complex work into manageable phases\n" +
  "- Before starting substantive work, create a task plan using the `update` action\n" +
  "- MUST `update` the task plan when the user makes new requests or changes requirements\n" +
  "- A plan has one goal and an ordered list of phases\n" +
  "- Phase count scales with task complexity: trivial chat (skip plan entirely), simple (2), typical (4-6), complex (10+)\n" +
  "- `capabilities` are role names that apply to this phase (e.g. [\"coding\"], [\"writing\", \"research\"]). They guide which best-practices are loaded; all tools remain available\n" +
  "- Each phase may take multiple tool calls and reasoning steps to complete\n" +
  "- Phases should be high-level units of work, not individual steps\n" +
  "- Make delivering the result a separate phase, typically the last one\n" +
  "- Set `current_phase_id` on `update`; no need to `advance` separately right after creating the plan\n" +
  "- When confident a phase is done, MUST `advance` to the next one\n" +
  "- `next_phase_id` MUST be the next sequential ID after the current one. Skipping or going backward is not allowed; revise via `update` if the plan is wrong\n" +
  "- When a new phase activates, relevant best-practices are returned in the tool result. Read them before working\n" +
  "- DO NOT end the task early unless the user explicitly asks\n" +
  "</instructions>\n\n" +
  "<recommended_usage>\n" +
  "- `update` to create the initial plan at the start of a non-trivial task\n" +
  "- `update` when the user makes a new request, changes scope, or reports a blocking issue\n" +
  "- `update` when significant new information emerges that invalidates the current plan\n" +
  "- `advance` when the current phase is complete and the next is ready to start\n" +
  "</recommended_usage>";

const POST_UPDATE_REMINDER =
  "If the user makes a request that changes task scope, requirements, priorities, or constraints, " +
  "or reports a blocking issue, you MUST first use the `plan` tool to `update` the task plan before " +
  "taking any other actions.";

// ─── Schema ──────────────────────────────────────────────────────────────────

const PARAMETERS = {
  type: "object" as const,
  properties: {
    action: {
      type: "string" as const,
      enum: ["update", "advance"],
      description: "The action to perform.",
    },
    goal: {
      type: "string" as const,
      description:
        "The overall goal of the task, written as a clear and concise sentence. Required for `update`.",
    },
    phases: {
      type: "array" as const,
      description:
        "Complete list of phases needed to achieve the goal. Required for `update`.",
      items: {
        type: "object" as const,
        description: "A phase in the task plan.",
        properties: {
          id: {
            type: "number" as const,
            description: "Phase ID. Positive integer (>= 1); renumbered 1..N internally.",
          },
          title: {
            type: "string" as const,
            description:
              "Concise human-readable title for this phase. Focus on what gets accomplished, not internal mechanics.",
          },
          capabilities: {
            type: "array" as const,
            description:
              "Role names that apply to this phase. Combine when multiple disciplines are needed. Leave empty if no role specialisation applies.",
            items: { type: "string" as const },
          },
          brief: {
            type: "string" as const,
            description: "Optional one-sentence preamble describing what this phase delivers.",
          },
        },
        required: ["id", "title"],
      },
    },
    current_phase_id: {
      type: "number" as const,
      description:
        "ID of the phase the task is currently in (>= 1). For `update`: defaults to phase 1.",
    },
    next_phase_id: {
      type: "number" as const,
      description:
        "ID of the phase the task is advancing to (>= 1). Required for `advance`. Must be the next sequential phase.",
    },
    summary: {
      type: "string" as const,
      description:
        "Optional one-sentence summary of what was accomplished in the phase being completed (only for `advance`).",
    },
    brief: {
      type: "string" as const,
      description: "A one-sentence preamble describing the purpose of this operation.",
    },
  },
  required: ["action", "brief"],
};

// ─── Register ────────────────────────────────────────────────────────────────

const PLAN_PROMPT_HINT = [
  "Planning (`plan` tool):",
  "- For trivial chat / one-shot questions, skip the plan tool entirely.",
  "- For substantive multi-step work, call `plan(action=update)` BEFORE doing meaningful work; phases are high-level units, not micro-steps.",
  "- Pass relevant `capabilities` (role names) on each phase — best-practices for those roles get attached on phase activation.",
  "- When the user changes scope, requirements, priorities, or constraints, call `plan(update)` again BEFORE other actions.",
  "- When the current phase is complete, call `plan(action=advance)` with the next sequential phase id; skipping is forbidden.",
].join("\n");

registerServerTool(
  {
    name: "plan",
    description: PLAN_DESCRIPTION,
    parameters: PARAMETERS,
    dangerLevel: "safe",
    promptHint: PLAN_PROMPT_HINT,
  },
  async (args, ctx): Promise<ToolHandlerResult> => {
    const action = String(args["action"] ?? "");
    switch (action) {
      case "update":  return await handleUpdate(args, ctx);
      case "advance": return await handleAdvance(args, ctx);
      default:
        return {
          content: `Error: unknown action '${action}'. Supported: update, advance.`,
          error: "unknown_action",
          summary: `plan(${action || "?"}) refused`,
        };
    }
  },
);

// ─── update ──────────────────────────────────────────────────────────────────

async function handleUpdate(
  args: Record<string, unknown>,
  ctx: TaskContext,
): Promise<ToolHandlerResult> {
  const goal = typeof args["goal"] === "string" ? args["goal"] : "";
  const rawPhases = args["phases"];
  const currentPhaseIdRaw = args["current_phase_id"];

  if (!goal) {
    return errorResult("plan(update)", "goal is required for update.");
  }
  if (!Array.isArray(rawPhases) || rawPhases.length === 0) {
    return errorResult("plan(update)", "phases array is required and must be non-empty.");
  }

  const normalised: Array<{
    id?: number;
    title: string;
    capabilities?: string[];
    brief?: string;
  }> = [];
  for (let i = 0; i < rawPhases.length; i++) {
    const item = rawPhases[i] as unknown;
    if (typeof item === "string") {
      normalised.push({ id: i + 1, title: item });
      continue;
    }
    if (
      typeof item === "object" &&
      item !== null &&
      typeof (item as Record<string, unknown>)["title"] === "string"
    ) {
      const obj = item as Record<string, unknown>;
      const phase: {
        id?: number;
        title: string;
        capabilities?: string[];
        brief?: string;
      } = { title: obj["title"] as string };

      if (typeof obj["id"] === "number" && Number.isInteger(obj["id"])) {
        phase.id = obj["id"] as number;
      }

      const caps = obj["capabilities"];
      if (Array.isArray(caps)) {
        const cleaned = caps.filter((c): c is string => typeof c === "string");
        if (cleaned.length > 0) phase.capabilities = cleaned;
      }

      if (typeof obj["brief"] === "string" && obj["brief"].length > 0) {
        phase.brief = obj["brief"];
      }

      normalised.push(phase);
      continue;
    }
    return errorResult(
      "plan(update)",
      `phases[${i}] is invalid. Each phase must be an object with at least { title }. Got: ${safeStringify(item)}`,
    );
  }

  const currentPhaseId =
    typeof currentPhaseIdRaw === "number" && Number.isInteger(currentPhaseIdRaw)
      ? currentPhaseIdRaw
      : undefined;

  const event: PlanEventUpdate = {
    type: "plan_update",
    goal,
    phases: normalised,
    ...(currentPhaseId !== undefined ? { currentPhaseId } : {}),
  };

  ctx.planState = applyPlanEvent(ctx.planState, event, ctx.taskId);
  if (!ctx.planState) {
    return errorResult("plan(update)", "internal: failed to apply plan_update event.");
  }

  const verb = ctx.planState.revisionCount > 1 ? "updated" : "created";
  const initialPhase = ctx.planState.phases.find(
    (p) => p.id === ctx.planState!.currentPhaseId,
  );
  const bp = await buildBestPracticesInjection(
    ctx.planState.currentPhaseId,
    initialPhase?.title ?? "",
    initialPhase?.capabilities,
  );
  const bpSection = bp ? `\n\n${bp}` : "";

  const planEvents: PlanEvent[] = [event];
  const reminders: PostReminder[] = [
    { reason: "plan_update_followup", content: POST_UPDATE_REMINDER },
  ];

  return {
    content: `Plan ${verb}.\n\n${formatPlan(ctx.planState)}${bpSection}`,
    summary: `plan(update) -> ${ctx.planState.phases.length} phases`,
    metadata: { planEvents },
    postReminders: reminders,
  };
}

// ─── advance ─────────────────────────────────────────────────────────────────

async function handleAdvance(
  args: Record<string, unknown>,
  ctx: TaskContext,
): Promise<ToolHandlerResult> {
  if (!ctx.planState) {
    return errorResult(
      "plan(advance)",
      "no active plan. Use the `update` action first to create one.",
    );
  }

  const plan = ctx.planState;
  const nextPhaseIdRaw = args["next_phase_id"];
  const nextPhaseId =
    typeof nextPhaseIdRaw === "number" && Number.isInteger(nextPhaseIdRaw)
      ? nextPhaseIdRaw
      : undefined;
  const summary = typeof args["summary"] === "string" ? args["summary"] : undefined;

  const currentIdx = plan.phases.findIndex((p) => p.id === plan.currentPhaseId);
  if (currentIdx < 0) {
    return errorResult(
      "plan(advance)",
      `current phase ${plan.currentPhaseId} not found in plan; revise via update.`,
    );
  }

  const lastIdx = plan.phases.length - 1;
  const isFinalPhase = currentIdx >= lastIdx;
  const expectedNext = isFinalPhase ? null : plan.phases[currentIdx + 1]!.id;

  if (isFinalPhase) {
    if (nextPhaseId !== undefined) {
      return errorResult(
        "plan(advance)",
        `cannot advance past the final phase. Use \`message(type=result)\` to deliver, or \`update\` to revise the plan.`,
      );
    }
  } else {
    if (nextPhaseId !== undefined && nextPhaseId !== expectedNext) {
      const nextPhase = plan.phases[currentIdx + 1]!;
      return errorResult(
        "plan(advance)",
        [
          `cannot advance to phase ${nextPhaseId}.`,
          `The next phase must be ${nextPhase.id} (${nextPhase.title}).`,
          `Phases must be completed in order. To skip or reorder, use \`update\` to revise the plan.`,
        ].join(" "),
      );
    }
  }

  const fromPhaseId = plan.phases[currentIdx]!.id;
  const event: PlanEventAdvance = {
    type: "plan_advance",
    fromPhaseId,
    toPhaseId: expectedNext,
    ...(summary !== undefined ? { summary } : {}),
  };

  ctx.planState = applyPlanEvent(ctx.planState, event, ctx.taskId);
  if (!ctx.planState) {
    return errorResult("plan(advance)", "internal: plan state lost during advance.");
  }

  const planEvents: PlanEvent[] = [event];

  if (isFinalPhase) {
    return {
      content:
        `All ${plan.phases.length} phases completed.\n\n${formatPlan(ctx.planState)}`,
      summary: `plan(advance) -> all phases done`,
      metadata: { planEvents },
    };
  }

  const nextPhase = ctx.planState.phases.find((p) => p.id === expectedNext);
  const bp = await buildBestPracticesInjection(
    expectedNext as number,
    nextPhase?.title ?? "",
    nextPhase?.capabilities,
  );
  const bpSection = bp ? `\n\n${bp}` : "";

  return {
    content:
      `Advanced to phase ${expectedNext}.\n\n${formatPlan(ctx.planState)}${bpSection}`,
    summary: `plan(advance) -> phase ${expectedNext}`,
    metadata: { planEvents },
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function errorResult(label: string, message: string): ToolHandlerResult {
  return {
    content: `Error: ${message}`,
    error: message,
    summary: `${label} refused`,
  };
}

function safeStringify(x: unknown): string {
  try {
    return JSON.stringify(x);
  } catch {
    return String(x);
  }
}
