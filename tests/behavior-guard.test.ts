/**
 * tests/behavior-guard.test.ts
 *
 * Pure unit tests for the BehaviorGuard.
 *
 * Coverage:
 *   - message(type=info) once → info_ack reminder
 *   - 3 consecutive info → info_ack + info_chain
 *   - mixed info/non-info → counter resets between
 *   - non-message tool → no reminder, info counter reset
 *   - first empty turn → gentle text
 *   - second+ empty turn → strong text with [Tool Use Enforcement]
 *   - productive turn resets empty counter
 *   - resetOnUserInteraction zeroes both counters
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { BehaviorGuard } from "../server/task/behavior-guard.js";

describe("BehaviorGuard — consecutive info", () => {
  it("emits info_ack on every info message", () => {
    const g = new BehaviorGuard();
    const r = g.afterToolExecution("message", { type: "info", text: "hi" }, false);
    assert.equal(r.length, 1);
    assert.equal(r[0]!.reason, "message_info_ack");
  });

  it("adds info_chain reminder once 3 in a row", () => {
    const g = new BehaviorGuard();
    g.afterToolExecution("message", { type: "info" }, false);
    g.afterToolExecution("message", { type: "info" }, false);
    const r = g.afterToolExecution("message", { type: "info" }, false);
    assert.equal(r.length, 2);
    assert.equal(r[0]!.reason, "message_info_ack");
    assert.equal(r[1]!.reason, "message_info_chain");
    assert.match(r[1]!.content, /3 consecutive info/);
  });

  it("resets info counter when an `ask` is sent", () => {
    const g = new BehaviorGuard();
    g.afterToolExecution("message", { type: "info" }, false);
    g.afterToolExecution("message", { type: "info" }, false);
    g.afterToolExecution("message", { type: "ask", text: "?" }, false);
    assert.equal(g._infoCount, 0);
    const r = g.afterToolExecution("message", { type: "info" }, false);
    // Single info_ack only — chain reminder doesn't fire after reset.
    assert.equal(r.length, 1);
    assert.equal(r[0]!.reason, "message_info_ack");
  });

  it("resets info counter when any non-message tool runs", () => {
    const g = new BehaviorGuard();
    g.afterToolExecution("message", { type: "info" }, false);
    g.afterToolExecution("message", { type: "info" }, false);
    g.afterToolExecution("read_file", { path: "/x" }, false);
    assert.equal(g._infoCount, 0);
  });

  it("non-message tool produces no reminder", () => {
    const g = new BehaviorGuard();
    const r = g.afterToolExecution("read_file", { path: "/x" }, false);
    assert.equal(r.length, 0);
  });
});

describe("BehaviorGuard — empty turns", () => {
  it("first empty turn returns gentle text", () => {
    const g = new BehaviorGuard();
    const r = g.onEmptyTurn();
    assert.equal(r.reason, "empty_turn");
    assert.match(r.content, /Either call a tool/);
  });

  it("second empty turn escalates", () => {
    const g = new BehaviorGuard();
    g.onEmptyTurn();
    const r = g.onEmptyTurn();
    assert.equal(r.reason, "empty_turn_persistent");
    assert.match(r.content, /Tool Use Enforcement/);
  });

  it("productive turn resets the empty counter", () => {
    const g = new BehaviorGuard();
    g.onEmptyTurn();
    g.onEmptyTurn();
    g.onProductiveTurn();
    assert.equal(g._emptyCount, 0);
    const r = g.onEmptyTurn();
    assert.equal(r.reason, "empty_turn"); // back to gentle
  });
});

describe("BehaviorGuard — user interaction", () => {
  it("resetOnUserInteraction zeroes both counters", () => {
    const g = new BehaviorGuard();
    g.afterToolExecution("message", { type: "info" }, false);
    g.afterToolExecution("message", { type: "info" }, false);
    g.onEmptyTurn();
    g.resetOnUserInteraction();
    assert.equal(g._infoCount, 0);
    assert.equal(g._emptyCount, 0);
  });
});
