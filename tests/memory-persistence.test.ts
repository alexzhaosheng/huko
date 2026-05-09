/**
 * tests/memory-persistence.test.ts
 *
 * Runs the SAME `runInfraSuite` and `runSessionSuite` against the
 * Memory backends. If a behavioural test passes for SQLite but fails
 * for Memory (or vice versa), that's a parity bug we want loud.
 *
 * Memory has no on-disk state and no transaction primitive — its
 * "atomicity" comes from JS being single-threaded between two
 * synchronous map sets — so it doesn't need the rollback test that
 * lives in `sqlite-session.test.ts`.
 */

import {
  MemoryInfraPersistence,
  MemorySessionPersistence,
} from "../server/persistence/memory.js";
import { runInfraSuite, runSessionSuite } from "./persistence-suite.js";

runInfraSuite("memory", () => {
  const instance = new MemoryInfraPersistence();
  return { instance, teardown: () => instance.close() };
});

runSessionSuite("memory", () => {
  const instance = new MemorySessionPersistence();
  return { instance, teardown: () => instance.close() };
});
