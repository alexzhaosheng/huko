/**
 * server/db/schema/index.ts
 *
 * Re-exports both schema namespaces for callers that want one or the
 * other. Each Drizzle DB handle is bound to ONE schema (infra or
 * session), so most callers should import directly from `./infra.js`
 * or `./session.js` rather than this barrel.
 */

export * as infra from "./infra.js";
export * as session from "./session.js";
