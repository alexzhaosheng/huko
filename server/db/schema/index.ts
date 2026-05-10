/**
 * server/db/schema/index.ts
 *
 * Re-exports the session schema. The sibling infra schema went away
 * when providers/models moved to JSON files (server/config/infra-config.ts).
 *
 * Most callers should import directly from `./session.js`.
 */

export * as session from "./session.js";
