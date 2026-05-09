/**
 * server/persistence/file.ts
 *
 * REMOVED in the persistence-split rework: the JSONL append-only
 * backend used to implement the combined `Persistence` interface,
 * which has now been split into InfraPersistence + SessionPersistence.
 *
 * The provider/model/config ops never made much sense in an
 * event-sourced log (they're write-once-mostly relational data, not
 * a stream); the session-only event log is still potentially useful
 * but has no current consumer, so we pulled the implementation rather
 * than let it bit-rot.
 *
 * If you actually want a JSONL session log, wire a fresh
 * `FileSessionPersistence` against the new `SessionPersistence`
 * interface. The previous implementation lived at this path and is
 * recoverable from git history.
 */

export {};
