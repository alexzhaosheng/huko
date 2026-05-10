/**
 * server/task/plan-state.ts
 *
 * Pure event applier + replay helpers for PlanState.
 *
 * Architecture:
 *   - PlanState is the runtime object held on TaskContext.planState.
 *   - We never persist PlanState directly. Instead, every plan tool call
 *     emits one or more PlanEvents, which ride along in the tool_result
 *     entry's metadata as `metadata.planEvents`.
 *   - On resume, walking the entry log and reapplying every PlanEvent in
 *     order rebuilds an identical PlanState.
 *
 * This file is pure (no I/O, no DB access) so it can be unit-tested
 * without spinning up a Persistence and is safe to import from anywhere.
 */

import type { EntryRow } from "../persistence/types.js";
import type {
  PlanEvent,
  PlanPhase,
  PlanPhaseStatus,
  PlanState,
} from "../../shared/plan-types.js";

// ─── applyPlanEvent — single-event reducer ───────────────────────────────────

/**
 * Apply a single `PlanEvent` to an existing `PlanState`, returning the
 * new state. Pure: never mutates `state`.
 *
 * `taskId` is required to set on freshly-created plans (initial
 * `plan_update`). Subsequent events preserve the existing taskId.
 *
 * `now` defaults to `new Date().toISOString()`. Tests can pass a fixed
 * timestamp for determinism.
 */
export function applyPlanEvent(
  state: PlanState | null,
  event: PlanEvent,
  taskId: number,
  now: string = new Date().toISOString(),
): PlanState | null {
  switch (event.type) {
    case "plan_update": {
      // Build phases from event payload and renumber 1..N (LLMs sometimes
      // hand us non-contiguous IDs; we always normalise).
      const phases: PlanPhase[] = event.phases.map((p, i) => {
        const id = i + 1;
        const phase: PlanPhase = {
          id,
          title: p.title,
          status: "pending",
        };
        if (p.capabilities && p.capabilities.length > 0) {
          phase.capabilities = [...p.capabilities];
        }
        if (p.brief) {
          phase.brief = p.brief;
        }
        return phase;
      });

      const effectiveCurrentId =
        clampPhaseId(event.currentPhaseId, phases.length) ??
        phases[0]?.id ??
        1;

      // Mark phase status based on effectiveCurrentId
      for (const phase of phases) {
        if (phase.id < effectiveCurrentId) {
          phase.status = "completed";
          phase.completedAt = now;
        } else if (phase.id === effectiveCurrentId) {
          phase.status = "active";
          phase.startedAt = now;
        }
      }

      return {
        goal: event.goal,
        phases,
        currentPhaseId: effectiveCurrentId,
        taskId: state?.taskId ?? taskId,
        createdAt: state?.createdAt ?? now,
        updatedAt: now,
        revisionCount: (state?.revisionCount ?? 0) + 1,
      };
    }

    case "plan_advance": {
      if (!state) return null;
      const next = clonePlan(state);

      const fromIdx = next.phases.findIndex((p) => p.id === event.fromPhaseId);
      if (fromIdx < 0) return next;

      const fromPhase = next.phases[fromIdx]!;
      fromPhase.status = "completed";
      fromPhase.completedAt = now;

      if (event.toPhaseId !== null) {
        const toPhase = next.phases.find((p) => p.id === event.toPhaseId);
        if (toPhase) {
          toPhase.status = "active" as PlanPhaseStatus;
          toPhase.startedAt = now;
          next.currentPhaseId = toPhase.id;
        }
      }

      next.updatedAt = now;
      return next;
    }
  }
}

// ─── rebuildPlanState — replay the entry log ─────────────────────────────────

/**
 * Reconstruct a PlanState by walking entries (filtered to a single
 * task) and replaying every `metadata.planEvents` array in order.
 *
 * Returns `null` if no plan events were ever recorded for the task.
 *
 * This function takes pre-fetched `EntryRow[]` rather than calling
 * persistence directly — keeps it pure and the caller decides where
 * the entries come from. The current persistence interface doesn't
 * have a `listForTask`; the orchestrator can filter `listForSession`
 * by `taskId` before calling this.
 */
export function rebuildPlanState(
  taskId: number,
  entries: EntryRow[],
): PlanState | null {
  let state: PlanState | null = null;

  for (const entry of entries) {
    if (entry.taskId !== taskId) continue;
    const meta = entry.metadata;
    if (!meta) continue;

    const toolName = meta["toolName"];
    if (toolName !== "plan") continue;

    const events = meta["planEvents"];
    if (!Array.isArray(events)) continue;

    for (const ev of events) {
      if (!isPlanEvent(ev)) continue;
      state = applyPlanEvent(state, ev, taskId);
    }
  }

  return state;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function clonePlan(plan: PlanState): PlanState {
  return JSON.parse(JSON.stringify(plan)) as PlanState;
}

/**
 * Returns the requested phase id if it's a positive integer within
 * `[1, count]`, otherwise `undefined` so callers fall back to phase 1.
 */
function clampPhaseId(id: number | undefined, count: number): number | undefined {
  if (id === undefined) return undefined;
  if (!Number.isInteger(id) || id < 1 || id > count) return undefined;
  return id;
}

function isPlanEvent(x: unknown): x is PlanEvent {
  if (!x || typeof x !== "object") return false;
  const t = (x as { type?: unknown }).type;
  return t === "plan_update" || t === "plan_advance";
}

// ─── formatPlan — human-readable text for the LLM tool result ────────────────

/**
 * Render a `PlanState` as a compact text block. This is what the LLM
 * sees as the tool_result content for `plan` calls.
 */
export function formatPlan(plan: PlanState): string {
  const completedCount = plan.phases.filter((p) => p.status === "completed").length;
  const totalCount = plan.phases.length;
  const progress = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;

  const phaseList = plan.phases
    .map((p) => {
      let marker: string;
      switch (p.status) {
        case "completed": marker = "✓"; break;
        case "active":    marker = "→"; break;
        case "skipped":   marker = "⊘"; break;
        default:          marker = " ";
      }
      const caps = p.capabilities && p.capabilities.length > 0
        ? ` [${p.capabilities.join(", ")}]`
        : "";
      const briefSuffix = p.brief ? ` — ${p.brief}` : "";
      return `  ${marker} ${p.id}. ${p.title}${caps}${briefSuffix}`;
    })
    .join("\n");

  const currentPhase = plan.phases.find((p) => p.id === plan.currentPhaseId);
  const currentLabel = currentPhase
    ? `${currentPhase.id}. ${currentPhase.title}`
    : "(none)";

  return [
    `<task_plan>`,
    `**Task**: #${plan.taskId}`,
    `**Goal**: ${plan.goal}`,
    `**Progress**: ${completedCount}/${totalCount} phases (${progress}%)`,
    `**Current**: ${currentLabel}`,
    ``,
    `Phases:`,
    phaseList,
    `</task_plan>`,
  ].join("\n");
}
