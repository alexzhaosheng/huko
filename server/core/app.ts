/**
 * server/core/app.ts
 *
 * Daemon-mode entry point.
 *
 * Boots:
 *   1. DB migrations (idempotent, SQLite persistence)
 *   2. SqlitePersistence — the daemon-mode persistence backend
 *   3. Express + plain HTTP server (so Socket.IO can attach)
 *   4. Socket.IO gateway → emitterFactory
 *   5. TaskOrchestrator wired up with persistence + gateway
 *   6. tRPC adapter at /api/trpc
 *   7. Health endpoint
 *   8. Listen
 *
 * This is one of huko's frontends — the "long-running daemon" one.
 * It exposes the kernel over HTTP + WebSocket so external clients
 * (CLI in daemon mode, future plugins, IDE extensions) can drive it.
 *
 * Other frontends (CLI one-shot, future) wire the kernel directly with
 * a different Persistence (typically MemoryPersistence) and no HTTP
 * surface at all.
 *
 * Graceful shutdown closes Socket.IO, the HTTP server, and the
 * persistence backend in order.
 */

import { createServer } from "node:http";
import express from "express";
import { createExpressMiddleware } from "@trpc/server/adapters/express";

import { runMigrations } from "../db/index.js";
import { SqlitePersistence } from "../persistence/index.js";
import { createGateway } from "../gateway.js";
import { TaskOrchestrator } from "../services/index.js";
import { appRouter } from "../routers/index.js";

// ─── Config ──────────────────────────────────────────────────────────────────

const PORT = Number(process.env["PORT"] ?? 3000);
const HOST = process.env["HOST"] ?? "127.0.0.1";

// ─── 1. Migrate ──────────────────────────────────────────────────────────────

const migrationResult = runMigrations();
if (migrationResult.applied.length > 0) {
  console.log(
    `db: applied ${migrationResult.applied.length} migration(s):`,
    migrationResult.applied.join(", "),
  );
}

// ─── 2. Persistence ──────────────────────────────────────────────────────────

const persistence = new SqlitePersistence();

// ─── 3. Express + HTTP ───────────────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: "10mb" }));

const httpServer = createServer(app);

// ─── 4. Gateway (Socket.IO) ──────────────────────────────────────────────────

const gateway = createGateway(httpServer);

// ─── 5. Orchestrator ─────────────────────────────────────────────────────────

const orchestrator = new TaskOrchestrator({
  persistence,
  emitterFactory: gateway.emitterFactory,
});

// ─── 6. tRPC ─────────────────────────────────────────────────────────────────

app.use(
  "/api/trpc",
  createExpressMiddleware({
    router: appRouter,
    createContext: () => ({ persistence, orchestrator }),
    onError({ error, path }) {
      console.error(`[trpc] ${path ?? "?"} -> ${error.code}: ${error.message}`);
    },
  }),
);

// ─── 7. Health / landing ─────────────────────────────────────────────────────

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "huko",
    migrationsApplied: migrationResult.applied,
    migrationsSkipped: migrationResult.skipped,
  });
});

app.get("/", (_req, res) => {
  res.type("text/plain").send(
    [
      "huko daemon",
      "",
      "  GET  /health      → liveness",
      "  POST /api/trpc/*  → tRPC procedures",
      "  WS   /socket.io   → event stream",
      "",
      "Drive me from a client (CLI or external UI). I have no UI of my own.",
    ].join("\n"),
  );
});

// ─── 8. Listen ───────────────────────────────────────────────────────────────

httpServer.listen(PORT, HOST, () => {
  console.log(`huko daemon listening on http://${HOST}:${PORT}`);
});

// ─── Graceful shutdown ───────────────────────────────────────────────────────

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`received ${signal}, shutting down`);
  try {
    await gateway.shutdown();
  } catch (err) {
    console.error("gateway.shutdown error:", err);
  }
  httpServer.close(() => {
    try {
      persistence.close?.();
    } catch {
      /* already closed */
    }
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5_000).unref();
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
