/**
 * tests/plan-tool.test.ts
 *
 * Pure unit tests for the plan tool — handler invoked directly with a
 * minimal stub TaskContext. No DB, no real best-practices loading
 * (capabilities use names that don't resolve to real role files, so
 * best-practices comes back empty).
 *
 * Coverage:
 *   - update creates plan; revisionCount starts at 1
 *   - update returns post-update reminder
 *   - update with current_phase_id activates the right phase
 *   - update normalises string-only phases
 *   - advance moves sequentially
 *   - advance refuses skipping forward
 *   - advance refuses going past the last phase
 *   - advance without prior plan errors
 *   - replay: walking emitted PlanEvents reconstructs identical PlanState
 *   - capabilities are preserved through events
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

// Side-effect: register tools.
import "../server/task/tools/index.js";
import { getTool, type ToolHandlerResult } from "../server/task/tools/registry.js";
import type { TaskContext } from "../server/engine/TaskContext.js";
import type { PlanState, PlanEvent } from "../shared/plan-types.js";
import { applyPlanEvent } from "../server/task/plan-state.js";

type StubContext = {
  taskId: number;
  planState: PlanState | null;
};

function makeCtx(taskId = 1): TaskContext {
  const stub: StubContext = { taskId, planState: null };
  return stub as unknown as TaskContext;
}

async function callPlan(
  ctx: TaskContext,
  args: Record<string, unknown>,
): Promise<ToolHandlerResult> {
  const tool = getTool("plan");
  if (!tool || tool.kind !== "server") throw new Error("plan tool not registered");
  const r = await Promise.resolve(tool.handler(args, ctx, { toolCallId: "test" }));
  if (typeof r === "string") return { content: r };
  if ("content" in r) return r as ToolHandlerResult;
  // legacy ServerToolResult
  return { content: r.result, error: r.error ?? null };
}

function eventsFrom(result: ToolHandlerResult): PlanEvent[] {
  const meta = result.metadata as { planEvents?: PlanEvent[] } | undefined;
  return meta?.planEvents ?? [];
}

// ─── update ─────────────────────────────────────────────────────────────────

describe("plan tool — update", () => {
  it("creates a fresh plan with revisionCount=1", async () => {
    const ctx = makeCtx();
    const r = await callPlan(ctx, {
      action: "update",
      brief: "initial plan",
      goal: "Build the thing",
      phases: [
        { id: 1, title: "Investigate" },
        { id: 2, title: "Implement" },
        { id: 3, title: "Verify and deliver" },
      ],
    });
    assert.equal(r.error ?? null, null, r.content);
    assert.ok(ctx.planState, "planState was populated on the ctx");
    assert.equal(ctx.planState!.goal, "Build the thing");
    assert.equal(ctx.planState!.phases.length, 3);
    assert.equal(ctx.planState!.revisionCount, 1);
    assert.equal(ctx.planState!.currentPhaseId, 1);
    assert.equal(ctx.planState!.phases[0]!.status, "active");
    assert.equal(ctx.planState!.phases[1]!.status, "pending");
  });

  it("returns the post-update reminder", async () => {
    const ctx = makeCtx();
    const r = await callPlan(ctx, {
      action: "update",
      brief: "initial plan",
      goal: "G",
      phases: [{ id: 1, title: "A" }, { id: 2, title: "B" }],
    });
    assert.ok(r.postReminders, "expected postReminders");
    assert.equal(r.postReminders!.length, 1);
    assert.equal(r.postReminders![0]!.reason, "plan_update_followup");
    assert.match(r.postReminders![0]!.content, /scope/i);
  });

  it("respects current_phase_id when set", async () => {
    const ctx = makeCtx();
    const r = await callPlan(ctx, {
      action: "update",
      brief: "starting mid-plan",
      goal: "G",
      phases: [
        { id: 1, title: "A" },
        { id: 2, title: "B" },
        { id: 3, title: "C" },
      ],
      current_phase_id: 2,
    });
    assert.equal(r.error ?? null, null);
    assert.equal(ctx.planState!.currentPhaseId, 2);
    assert.equal(ctx.planState!.phases[0]!.status, "completed");
    assert.equal(ctx.planState!.phases[1]!.status, "active");
    assert.equal(ctx.planState!.phases[2]!.status, "pending");
  });

  it("normalises string-only phases", async () => {
    const ctx = makeCtx();
    const r = await callPlan(ctx, {
      action: "update",
      brief: "shorthand",
      goal: "G",
      phases: ["First", "Second", "Third"],
    });
    assert.equal(r.error ?? null, null);
    assert.equal(ctx.planState!.phases.length, 3);
    assert.equal(ctx.planState!.phases[1]!.title, "Second");
  });

  it("preserves capabilities array on phases", async () => {
    const ctx = makeCtx();
    await callPlan(ctx, {
      action: "update",
      brief: "with caps",
      goal: "G",
      phases: [
        { id: 1, title: "Read code", capabilities: ["coding"] },
        { id: 2, title: "Write report", capabilities: ["writing", "research"] },
      ],
    });
    assert.deepEqual(ctx.planState!.phases[0]!.capabilities, ["coding"]);
    assert.deepEqual(ctx.planState!.phases[1]!.capabilities, ["writing", "research"]);
  });

  it("rejects empty goal", async () => {
    const ctx = makeCtx();
    const r = await callPlan(ctx, {
      action: "update",
      brief: "x",
      phases: [{ id: 1, title: "Only" }],
    });
    assert.ok(r.error, "expected error");
    assert.match(r.content, /goal is required/i);
  });

  it("rejects empty phases", async () => {
    const ctx = makeCtx();
    const r = await callPlan(ctx, {
      action: "update",
      brief: "x",
      goal: "G",
      phases: [],
    });
    assert.ok(r.error);
    assert.match(r.content, /phases/i);
  });

  it("bumps revisionCount on subsequent updates", async () => {
    const ctx = makeCtx();
    await callPlan(ctx, {
      action: "update",
      brief: "v1",
      goal: "G",
      phases: [{ id: 1, title: "X" }],
    });
    await callPlan(ctx, {
      action: "update",
      brief: "v2",
      goal: "G",
      phases: [{ id: 1, title: "X1" }, { id: 2, title: "X2" }],
    });
    assert.equal(ctx.planState!.revisionCount, 2);
    assert.equal(ctx.planState!.phases.length, 2);
  });
});

// ─── advance ────────────────────────────────────────────────────────────────

describe("plan tool — advance", () => {
  it("advances sequentially", async () => {
    const ctx = makeCtx();
    await callPlan(ctx, {
      action: "update",
      brief: "init",
      goal: "G",
      phases: [
        { id: 1, title: "A" },
        { id: 2, title: "B" },
        { id: 3, title: "C" },
      ],
    });
    const r = await callPlan(ctx, {
      action: "advance",
      brief: "moving",
      next_phase_id: 2,
    });
    assert.equal(r.error ?? null, null, r.content);
    assert.equal(ctx.planState!.currentPhaseId, 2);
    assert.equal(ctx.planState!.phases[0]!.status, "completed");
    assert.equal(ctx.planState!.phases[1]!.status, "active");
  });

  it("refuses skipping forward", async () => {
    const ctx = makeCtx();
    await callPlan(ctx, {
      action: "update",
      brief: "init",
      goal: "G",
      phases: [{ id: 1, title: "A" }, { id: 2, title: "B" }, { id: 3, title: "C" }],
    });
    const r = await callPlan(ctx, {
      action: "advance",
      brief: "skip",
      next_phase_id: 3,
    });
    assert.ok(r.error);
    assert.match(r.content, /must be 2/i);
    // State unchanged
    assert.equal(ctx.planState!.currentPhaseId, 1);
  });

  it("refuses going backward", async () => {
    const ctx = makeCtx();
    await callPlan(ctx, {
      action: "update",
      brief: "init",
      goal: "G",
      phases: [{ id: 1, title: "A" }, { id: 2, title: "B" }],
      current_phase_id: 2,
    });
    const r = await callPlan(ctx, {
      action: "advance",
      brief: "back",
      next_phase_id: 1,
    });
    assert.ok(r.error);
    assert.match(r.content, /cannot advance past the final phase|must be/i);
    assert.equal(ctx.planState!.currentPhaseId, 2);
  });

  it("completes the last phase when advancing from final", async () => {
    const ctx = makeCtx();
    await callPlan(ctx, {
      action: "update",
      brief: "init",
      goal: "G",
      phases: [{ id: 1, title: "A" }, { id: 2, title: "B" }],
      current_phase_id: 2,
    });
    const r = await callPlan(ctx, { action: "advance", brief: "done" });
    assert.equal(r.error ?? null, null, r.content);
    assert.match(r.content, /All 2 phases completed/);
    assert.equal(ctx.planState!.phases[1]!.status, "completed");
  });

  it("errors when no plan exists", async () => {
    const ctx = makeCtx();
    const r = await callPlan(ctx, { action: "advance", brief: "no-plan" });
    assert.ok(r.error);
    assert.match(r.content, /no active plan/i);
  });

  it("does NOT emit a post-update reminder on advance", async () => {
    const ctx = makeCtx();
    await callPlan(ctx, {
      action: "update",
      brief: "init",
      goal: "G",
      phases: [{ id: 1, title: "A" }, { id: 2, title: "B" }],
    });
    const r = await callPlan(ctx, {
      action: "advance",
      brief: "go",
      next_phase_id: 2,
    });
    assert.equal(r.postReminders, undefined);
  });
});

// ─── replay ─────────────────────────────────────────────────────────────────

describe("plan tool — replay from events", () => {
  it("rebuilds an identical state by replaying captured planEvents", async () => {
    const live = makeCtx();
    const collected: PlanEvent[] = [];

    const r1 = await callPlan(live, {
      action: "update",
      brief: "v1",
      goal: "G",
      phases: [
        { id: 1, title: "A", capabilities: ["coding"] },
        { id: 2, title: "B" },
        { id: 3, title: "C" },
      ],
    });
    collected.push(...eventsFrom(r1));

    const r2 = await callPlan(live, {
      action: "advance",
      brief: "go",
      next_phase_id: 2,
    });
    collected.push(...eventsFrom(r2));

    const r3 = await callPlan(live, {
      action: "update",
      brief: "v2",
      goal: "G2",
      phases: [
        { id: 1, title: "A2" },
        { id: 2, title: "B2" },
      ],
      current_phase_id: 2,
    });
    collected.push(...eventsFrom(r3));

    // Replay
    let replayed: PlanState | null = null;
    for (const ev of collected) {
      replayed = applyPlanEvent(replayed, ev, 1);
    }

    assert.ok(replayed);
    // Compare structure (strip timestamps which differ between runs)
    const stripTs = (s: PlanState): unknown => ({
      ...s,
      createdAt: "T",
      updatedAt: "T",
      phases: s.phases.map((p) => ({
        ...p,
        ...(p.startedAt !== undefined ? { startedAt: "T" } : {}),
        ...(p.completedAt !== undefined ? { completedAt: "T" } : {}),
      })),
    });
    assert.deepEqual(stripTs(replayed), stripTs(live.planState!));
  });
});

// ─── unknown action ─────────────────────────────────────────────────────────

describe("plan tool — misc", () => {
  it("rejects unknown action", async () => {
    const ctx = makeCtx();
    const r = await callPlan(ctx, { action: "delete", brief: "?" });
    assert.ok(r.error);
    assert.match(r.content, /unknown action/i);
  });
});
