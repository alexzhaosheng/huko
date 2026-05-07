/**
 * server/core/app.ts
 *
 * Minimal server bootstrap for local development.
 *
 * The broader gateway/router stack is still being built, but we keep a
 * real entrypoint here so `npm run dev` and `npm run build` work today.
 */

import express from "express";
import { runMigrations, sqlite } from "../db/index.js";

const PORT = Number(process.env["PORT"] ?? 3000);
const HOST = process.env["HOST"] ?? "127.0.0.1";

const migrationResult = runMigrations();
const app = express();

app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "huko",
    migrationsApplied: migrationResult.applied,
    migrationsSkipped: migrationResult.skipped,
  });
});

app.get("/", (_req, res) => {
  res.type("text/plain").send("huko server is running");
});

const server = app.listen(PORT, HOST, () => {
  console.log(`huko server listening on http://${HOST}:${PORT}`);
});

function shutdown(signal: string): void {
  console.log(`received ${signal}, shutting down`);
  server.close(() => {
    sqlite.close();
    process.exit(0);
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
