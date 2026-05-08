/**
 * server/core/app.ts
 *
 * Daemon-mode entry point.
 *
 * Boots:
 *   1. SqlitePersistence — its constructor migrates idempotently
 *   2. Express + plain HTTP server (so Socket.IO can attach)
 *   3. Socket.IO gateway -> emitterFactory
 *   4. TaskOrchestrator wired up with persistence + gateway
 *   5. tRPC adapter at /api/trpc
 *   6. Health endpoint
 *   7. Listen
 *
 * This is one of huko's frontends — the "long-running daemon" one.
 * It exposes the kernel over HTTP + WebSocket so external clients
 * (CLI in daemon mode, future plugins, IDE extensions) can drive it.
 *
 * Other frontends (CLI one-shot) wire the kernel directly with whatever
 * Persistence they want and no HTTP surface at all.
 *
 * Graceful shutdown closes Socket.IO, the HTTP server, and the
 * persistence backend in order.
 */

import { createServer } from "node:http";
import express from "express";
import { createExpressMiddleware } from "@trpc/server/adapters/express";

import { SqlitePersistence } from "../persistence/index.js";
import { createGateway } from "../gateway.js";
import { TaskOrchestrator } from "../services/index.js";
import { appRouter } from "../routers/index.js";

// ─── Config ──────────────────────────────────────────────────────────────────

const PORT = Number(process.env["PORT"] ?? 3000);
const HOST = process.env["HOST"] ?? "127.0.0.1";

// ─── 1. Persistence ──────────────────────────────────────────────────────────

// SqlitePersistence's constructor runs migrations idempotently — schema
// management is its own concern, the daemon doesn't need to know.
const persistence = new SqlitePersistence();

// ─── 2. Express + HTTP ───────────────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: "10mb" }));

const httpServer = createServer(app);

// ─── 3. Gateway (Socket.IO) ──────────────────────────────────────────────────

const gateway = createGateway(httpServer);

// ─── 4. Orchestrator ─────────────────────────────────────────────────────────

const orchestrator = new TaskOrchestrator({
  persistence,
  emitterFactory: gateway.emitterFactory,
});

// ─── 5. tRPC ─────────────────────────────────────────────────────────────────

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

// ─── 6. Health / landing ─────────────────────────────────────────────────────

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "huko" });
});

app.get("/", (_req, res) => {
  res.type("text/plain").send(
    [
      "huko daemon",
      "",
      "  GET  /health      -> liveness",
      "  POST /api/trpc/*  -> tRPC procedures",
      "  WS   /socket.io   -> event stream",
      "",
      "Drive me from a client (CLI or external UI). I have no UI of my own.",
    ].join("\n"),
  );
});

// ─── 7. Listen ───────────────────────────────────────────────────────────────

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
      void persistence.close();
    } catch {
      /* already closed */
    }
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5_000).unref();
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

