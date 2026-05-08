/**
 * server/gateway.ts
 *
 * Socket.IO gateway — daemon-mode only.
 *
 * Two jobs:
 *   1. Accept WebSocket connections; let clients subscribe to session
 *      rooms (e.g. "chat:42"). One room per (sessionType, sessionId).
 *   2. Hand the orchestrator an `EmitterFactory` whose result, given a
 *      room, returns an `Emitter` that forwards `HukoEvent`s to that
 *      room over the single Socket.IO event name `HUKO_WIRE_EVENT`.
 *
 * Wire protocol: ALL kernel events (entry, delta, task lifecycle) go
 * through one socket event name. Client side listens once and switches
 * on `event.type`. See `shared/events.ts`.
 *
 * The gateway does NOT route user actions (sendMessage / stop) — those
 * go through tRPC. WebSocket is push-only (server → client).
 *
 * Multi-client coherence: every event is emitted to a room (not a
 * specific socket), so opening the same chat in two tabs / a CLI
 * client / a third frontend just works — all of them subscribe and
 * all receive.
 */

import type { Server as HTTPServer } from "node:http";
import { Server as SocketIOServer } from "socket.io";
import type { EmitterFactory } from "./services/index.js";
import { HUKO_WIRE_EVENT, type HukoEvent } from "../shared/events.js";

export type Gateway = {
  io: SocketIOServer;
  emitterFactory: EmitterFactory;
  shutdown: () => Promise<void>;
};

/**
 * Only allow subscribing to rooms shaped like "chat:<id>" or "agent:<id>"
 * with a sane number length. Defends against subscribing to arbitrary
 * strings — narrow blast radius even though we have no auth (single-user).
 */
const ROOM_RX = /^(chat|agent):\d{1,10}$/;

export function createGateway(httpServer: HTTPServer): Gateway {
  const io = new SocketIOServer(httpServer, {
    cors: { origin: true, credentials: true },
    pingInterval: 20_000,
    pingTimeout: 60_000,
  });

  io.on("connection", (socket) => {
    socket.on("subscribe", (room: unknown) => {
      if (typeof room !== "string" || !ROOM_RX.test(room)) return;
      void socket.join(room);
    });
    socket.on("unsubscribe", (room: unknown) => {
      if (typeof room !== "string") return;
      void socket.leave(room);
    });
  });

  const emitterFactory: EmitterFactory = (room) => ({
    emit: (event: HukoEvent) => {
      io.to(room).emit(HUKO_WIRE_EVENT, event);
    },
  });

  return {
    io,
    emitterFactory,
    shutdown: async () => {
      await new Promise<void>((resolve) => {
        io.close(() => resolve());
      });
    },
  };
}
