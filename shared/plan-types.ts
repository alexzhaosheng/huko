/**
 * shared/plan-types.ts
 *
 * Plan state + plan events. Cross-runtime types shared between the
 * kernel (handler, replayer) and frontends (UI, eventually).
 *
 * Architecture:
 *   - `PlanState` is the runtime object held on `TaskContext.planState`.
 *   - It is NEVER persisted directly. Only `PlanEvent`s are stored in
 *     the entry log via `tool_result` metadata (`metadata.planEvents`).
 *   - On task resume, replay all PlanEvent entries in order to
 *     reconstruct PlanState. See `server/task/plan-state.ts`.
 *
 * Capability shape note (huko diverges from WeavesAI here):
 *   WeavesAI used a fixed boolean map (creative_writing, web_development,
 *   …). huko uses `string[]` of role names. Multiple roles can be active
 *   in one phase (e.g. ["coding", "writing"]) and the role files are
 *   the source of truth for what each name means. This keeps the
 *   capability vocabulary user-extensible — drop a markdown into
 *   `~/.huko/roles/<name>.md` and it becomes a usable capability.
 */

export type PlanPhaseStatus = "pending" | "active" | "completed" | "skipped";

export type PlanPhase = {
  id: number;
  title: string;
  status: PlanPhaseStatus;
  /**
   * Role names that this phase activates. Each entry should resolve to
   * a role file (project / user / built-in). Unknown names are tolerated
   * — they just don't contribute best-practices on activation.
   */
  capabilities?: string[];
  /** Optional one-sentence preamble describing what this phase delivers. */
  brief?: string;
  /** ISO timestamp when the phase moved to `active`. */
  startedAt?: string;
  /** ISO timestamp when the phase moved to `completed`. */
  completedAt?: string;
};

export type PlanState = {
  goal: string;
  phases: PlanPhase[];
  currentPhaseId: number;
  taskId: number;
  /** ISO timestamp when the plan was first created (preserved across updates). */
  createdAt: string;
  /** ISO timestamp of the most recent update or advance. */
  updatedAt: string;
  /** Bumped on every `update`. Starts at 1. */
  revisionCount: number;
};

// ─── Events ───────────────────────────────────────────────────────────────────

export type PlanEventUpdate = {
  type: "plan_update";
  goal: string;
  phases: Array<{
    id?: number;
    title: string;
    capabilities?: string[];
    brief?: string;
  }>;
  /** Defaults to phase 1 when omitted. */
  currentPhaseId?: number;
};

export type PlanEventAdvance = {
  type: "plan_advance";
  fromPhaseId: number;
  /** `null` means we just completed the final phase — there's no next. */
  toPhaseId: number | null;
  summary?: string;
};

export type PlanEvent = PlanEventUpdate | PlanEventAdvance;
