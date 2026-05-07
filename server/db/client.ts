/**
 * server/db/client.ts
 *
 * Database singleton. better-sqlite3 + Drizzle.
 *
 * better-sqlite3 is SYNCHRONOUS under the hood — every statement executes
 * inline on the calling thread. Drizzle wraps the API in Promise-shaped
 * methods for ergonomics, but no real async work happens.
 *
 * Notable consequence: `db.transaction(...)` MUST take a synchronous
 * callback. Do not pass an async function — drizzle will silently commit
 * before the awaited work completes.
 *
 * The DB file lives at:
 *   - $HUKO_DB_PATH if set
 *   - ./huko.db otherwise (relative to process cwd)
 *
 * SQLite knobs we set:
 *   - journal_mode = WAL    — concurrent readers + single writer
 *   - foreign_keys = ON     — enforce CASCADE deletes
 */

import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";

const dbPath = process.env["HUKO_DB_PATH"] ?? path.join(process.cwd(), "huko.db");

/** The raw better-sqlite3 handle. Use this for migrations and PRAGMAs. */
export const sqlite = new Database(dbPath);

sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");

/** Drizzle handle. Use this for typed CRUD. */
export const db = drizzle(sqlite, { schema });

export type Db = typeof db;
