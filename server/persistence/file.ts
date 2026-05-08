/**
 * server/persistence/file.ts
 *
 * Append-only JSONL `Persistence` implementation.
 *
 * Every mutation is recorded as a one-line JSON "op". State is rebuilt
 * by replaying the file on startup. Reads are pure in-memory after replay.
 *
 * Why this exists:
 *   - Trivial debugging: `cat huko.jsonl` shows the entire history.
 *   - Trivially shippable to log services (fluentd, kafka, S3 sync, ...).
 *   - Append-only is event-sourced — pairs naturally with `HukoEvent`.
 *   - Crash safety: append-only writes don't corrupt prior history.
 *   - Zero schema migrations — ops carry their own shape.
 *
 * Tradeoffs vs SQLite:
 *   - Reads are O(N) at startup (one full replay).
 *   - No indexes — everything's a Map scan.
 *   - Fine for hundreds of sessions; not for huge multi-tenant scale.
 *
 * File path: `opts.path`. Recommended: `huko.jsonl` in cwd, or
 * `$HUKO_LOG_PATH`. The file is opened with O_APPEND so concurrent
 * writers from different processes don't shred each other's bytes
 * (atomic up to PIPE_BUF ≈ 4 KB on Linux/macOS).
 *
 * Cascade: `session.delete` is recorded as ONE op — replay logic does
 * the cascade (drops tasks + entries owned by that session). Saves bytes
 * and keeps the log readable.
 *
 * Tolerance: lines that fail to JSON.parse, or carry an unknown `op`,
 * are skipped during replay with a stderr warning. The last write can
 * theoretically be torn for ops > PIPE_BUF — that line is just lost.
 */

import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
} from "node:fs";
import { isLLMVisible } from "../../shared/types.js";
import { collectElidedEntryIds } from "./memory.js";
import type {
  Protocol,
  ThinkLevel,
  ToolCall,
  ToolCallMode,
} from "../../shared/llm-protocol.js";
import type {
  EntryKind,
  SessionType,
  TaskStatus,
} from "../../shared/types.js";
import type { LLMMessage } from "../core/llm/types.js";
import type {
  ChatSessionRow,
  ConfigRow,
  CreateChatSessionInput,
  CreateModelInput,
  CreateProviderInput,
  CreateTaskInput,
  EntryRow,
  ModelRow,
  ModelRowJoined,
  Persistence,
  ProviderRow,
  ResolvedModelConfig,
  TaskRow,
  UpdateProviderPatch,
  UpdateTaskPatch,
} from "./types.js";

// ─── Op shape ────────────────────────────────────────────────────────────────

type Op =
  // sessions
  | {
      op: "session.create";
      id: number;
      title: string;
      createdAt: number;
      updatedAt: number;
    }
  | { op: "session.delete"; id: number; ts: number }
  // tasks
  | {
      op: "task.create";
      id: number;
      chatSessionId: number | null;
      agentSessionId: number | null;
      modelId: string;
      toolCallMode: ToolCallMode;
      thinkLevel: ThinkLevel;
      status: TaskStatus;
      createdAt: number;
      updatedAt: number;
    }
  | { op: "task.update"; id: number; patch: UpdateTaskPatch; updatedAt: number }
  // entries
  | {
      op: "entry.append";
      id: number;
      taskId: number;
      sessionId: number;
      sessionType: SessionType;
      kind: string;
      role: "system" | "user" | "assistant" | "tool";
      content: string;
      toolCallId: string | null;
      thinking: string | null;
      metadata: Record<string, unknown> | null;
      createdAt: number;
    }
  | {
      op: "entry.update";
      id: number;
      patch: {
        content?: string;
        metadata?: Record<string, unknown>;
        mergeMetadata?: boolean;
      };
    }
  // providers
  | {
      op: "provider.create";
      id: number;
      name: string;
      protocol: Protocol;
      baseUrl: string;
      apiKey: string;
      defaultHeaders: Record<string, string> | null;
      createdAt: number;
    }
  | { op: "provider.update"; id: number; patch: UpdateProviderPatch }
  | { op: "provider.delete"; id: number }
  // models
  | {
      op: "model.create";
      id: number;
      providerId: number;
      modelId: string;
      displayName: string;
      defaultThinkLevel: ThinkLevel;
      defaultToolCallMode: ToolCallMode;
      createdAt: number;
    }
  | { op: "model.delete"; id: number }
  // config
  | {
      op: "config.set";
      key: string;
      value: unknown;
      updatedAt: number;
    };

// ─── Options ─────────────────────────────────────────────────────────────────

export type FilePersistenceOptions = {
  /** Absolute or cwd-relative file path. Created if it doesn't exist. */
  path: string;
  /**
   * If true, fsync after every op write — durability over throughput.
   * Default false: rely on OS page cache + filesystem journal.
   * Suitable to enable for production daemons; usually overkill for CLI.
   */
  fsync?: boolean;
};

// ─── FilePersistence ─────────────────────────────────────────────────────────

export class FilePersistence implements Persistence {
  private nextId = 1;
  private readonly _sessions = new Map<number, ChatSessionRow>();
  private readonly _tasks = new Map<number, TaskRow>();
  private readonly _entries = new Map<number, EntryRow>();
  private readonly _providers = new Map<number, ProviderRow>();
  private readonly _models = new Map<number, ModelRow>();
  private readonly _config = new Map<string, ConfigRow>();

  private readonly path: string;
  private readonly fsyncEnabled: boolean;
  private fd: number | null = null;

  readonly entries: Persistence["entries"];
  readonly sessions: Persistence["sessions"];
  readonly tasks: Persistence["tasks"];
  readonly providers: Persistence["providers"];
  readonly models: Persistence["models"];
  readonly config: Persistence["config"];

  constructor(opts: FilePersistenceOptions) {
    this.path = opts.path;
    this.fsyncEnabled = opts.fsync ?? false;

    if (existsSync(this.path)) this.replay();
    this.fd = openSync(this.path, "a");

    const allocId = (): number => this.nextId++;
    const now = (): number => Date.now();
    const writeOp = (op: Op): void => this.writeOp(op);

    // ── entries ────────────────────────────────────────────────────────────
    this.entries = {
      persist: async (entry) => {
        const id = allocId();
        const op: Op = {
          op: "entry.append",
          id,
          taskId: entry.taskId,
          sessionId: entry.sessionId,
          sessionType: entry.sessionType,
          kind: entry.kind,
          role: entry.role,
          content: entry.content,
          toolCallId: entry.toolCallId ?? null,
          thinking: entry.thinking ?? null,
          metadata: entry.metadata ?? null,
          createdAt: now(),
        };
        this.applyOp(op);
        writeOp(op);
        return id;
      },
      update: async (entryId, patch) => {
        if (!this._entries.has(entryId)) return;
        const op: Op = {
          op: "entry.update",
          id: entryId,
          patch: {
            ...(patch.content !== undefined ? { content: patch.content } : {}),
            ...(patch.metadata !== undefined ? { metadata: patch.metadata } : {}),
            ...(patch.mergeMetadata !== undefined
              ? { mergeMetadata: patch.mergeMetadata }
              : {}),
          },
        };
        this.applyOp(op);
        writeOp(op);
      },
      loadLLMContext: async (sessionId, type) => {
        const rows = this.entriesForSession(sessionId, type);
        const dropped = collectElidedEntryIds(rows);
        const out: LLMMessage[] = [];
        for (const r of rows) {
          if (dropped.has(r.id)) continue;
          const m = projectToLLMMessage(r);
          if (m) out.push(m);
        }
        return out;
      },
      listForSession: async (sessionId, type) => this.entriesForSession(sessionId, type),
    };

    // ── sessions ───────────────────────────────────────────────────────────
    this.sessions = {
      create: async (input: CreateChatSessionInput) => {
        const id = allocId();
        const t = now();
        const op: Op = {
          op: "session.create",
          id,
          title: input.title ?? "",
          createdAt: t,
          updatedAt: t,
        };
        this.applyOp(op);
        writeOp(op);
        return id;
      },
      list: async () =>
        [...this._sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt),
      get: async (id) => this._sessions.get(id) ?? null,
      delete: async (id) => {
        if (!this._sessions.has(id)) return;
        const op: Op = { op: "session.delete", id, ts: now() };
        this.applyOp(op);
        writeOp(op);
      },
    };

    // ── tasks ──────────────────────────────────────────────────────────────
    this.tasks = {
      create: async (input: CreateTaskInput) => {
        const id = allocId();
        const t = now();
        const op: Op = {
          op: "task.create",
          id,
          chatSessionId: input.chatSessionId,
          agentSessionId: input.agentSessionId,
          modelId: input.modelId,
          toolCallMode: input.toolCallMode,
          thinkLevel: input.thinkLevel,
          status: input.status ?? "running",
          createdAt: t,
          updatedAt: t,
        };
        this.applyOp(op);
        writeOp(op);
        return id;
      },
      update: async (id, patch: UpdateTaskPatch) => {
        if (!this._tasks.has(id)) return;
        const op: Op = { op: "task.update", id, patch, updatedAt: now() };
        this.applyOp(op);
        writeOp(op);
      },
      get: async (id) => this._tasks.get(id) ?? null,
      listNonTerminal: async () => {
        const out: TaskRow[] = [];
        for (const t of this._tasks.values()) {
          if (t.status !== "done" && t.status !== "failed" && t.status !== "stopped") {
            out.push(t);
          }
        }
        return out;
      },
    };

    // ── providers ──────────────────────────────────────────────────────────
    this.providers = {
      list: async () => [...this._providers.values()],
      create: async (input: CreateProviderInput) => {
        const id = allocId();
        const op: Op = {
          op: "provider.create",
          id,
          name: input.name,
          protocol: input.protocol,
          baseUrl: input.baseUrl,
          apiKey: input.apiKey,
          defaultHeaders: input.defaultHeaders ?? null,
          createdAt: now(),
        };
        this.applyOp(op);
        writeOp(op);
        return id;
      },
      update: async (id, patch: UpdateProviderPatch) => {
        if (!this._providers.has(id)) return;
        const op: Op = { op: "provider.update", id, patch };
        this.applyOp(op);
        writeOp(op);
      },
      delete: async (id) => {
        if (!this._providers.has(id)) return;
        const op: Op = { op: "provider.delete", id };
        this.applyOp(op);
        writeOp(op);
      },
    };

    // ── models ─────────────────────────────────────────────────────────────
    this.models = {
      list: async (): Promise<ModelRowJoined[]> => {
        const out: ModelRowJoined[] = [];
        for (const m of this._models.values()) {
          const p = this._providers.get(m.providerId);
          if (!p) continue;
          out.push({ ...m, providerName: p.name, providerProtocol: p.protocol });
        }
        return out;
      },
      create: async (input: CreateModelInput) => {
        const id = allocId();
        const op: Op = {
          op: "model.create",
          id,
          providerId: input.providerId,
          modelId: input.modelId,
          displayName: input.displayName,
          defaultThinkLevel: input.defaultThinkLevel ?? "off",
          defaultToolCallMode: input.defaultToolCallMode ?? "native",
          createdAt: now(),
        };
        this.applyOp(op);
        writeOp(op);
        return id;
      },
      delete: async (id) => {
        if (!this._models.has(id)) return;
        const op: Op = { op: "model.delete", id };
        this.applyOp(op);
        writeOp(op);
      },
      resolveConfig: async (modelId): Promise<ResolvedModelConfig | null> => {
        const m = this._models.get(modelId);
        if (!m) return null;
        const p = this._providers.get(m.providerId);
        if (!p) return null;
        return {
          modelId: m.modelId,
          protocol: p.protocol,
          baseUrl: p.baseUrl,
          apiKey: p.apiKey,
          toolCallMode: m.defaultToolCallMode,
          thinkLevel: m.defaultThinkLevel,
          defaultHeaders: p.defaultHeaders,
        };
      },
    };

    // ── config ─────────────────────────────────────────────────────────────
    this.config = {
      get: async (key) => this._config.get(key)?.value ?? null,
      set: async (key, value) => {
        const op: Op = { op: "config.set", key, value, updatedAt: now() };
        this.applyOp(op);
        writeOp(op);
      },
      list: async () => [...this._config.values()],
      getDefaultModelId: async () => {
        const v = this._config.get("default_model_id")?.value;
        return typeof v === "number" ? v : null;
      },
      setDefaultModelId: async (modelId) => {
        await this.config.set("default_model_id", modelId);
      },
    };
  }

  close(): void {
    if (this.fd === null) return;
    try {
      if (this.fsyncEnabled) fsyncSync(this.fd);
      closeSync(this.fd);
    } catch {
      /* already closed */
    }
    this.fd = null;
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  private writeOp(op: Op): void {
    if (this.fd === null) throw new Error("FilePersistence: file handle is closed");
    const line = JSON.stringify(op) + "\n";
    appendFileSync(this.fd, line);
    if (this.fsyncEnabled) fsyncSync(this.fd);
  }

  private replay(): void {
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch (err) {
      throw new Error(
        `FilePersistence: failed to read ${this.path}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const lines = raw.split("\n");
    let bad = 0;
    for (const line of lines) {
      if (line.length === 0) continue;
      let op: Op;
      try {
        op = JSON.parse(line) as Op;
      } catch {
        bad++;
        continue;
      }
      try {
        this.applyOp(op);
      } catch {
        bad++;
      }
    }
    if (bad > 0) {
      process.stderr.write(
        `[FilePersistence] skipped ${bad} bad line(s) during replay of ${this.path}\n`,
      );
    }
  }

  private applyOp(op: Op): void {
    switch (op.op) {
      case "session.create":
        this._sessions.set(op.id, {
          id: op.id,
          title: op.title,
          createdAt: op.createdAt,
          updatedAt: op.updatedAt,
        });
        this.bumpId(op.id);
        return;

      case "session.delete": {
        this._sessions.delete(op.id);
        // cascade: drop tasks belonging to this session, then their entries
        const droppedTaskIds = new Set<number>();
        for (const [tid, t] of this._tasks) {
          if (t.chatSessionId === op.id || t.agentSessionId === op.id) {
            this._tasks.delete(tid);
            droppedTaskIds.add(tid);
          }
        }
        for (const [eid, e] of this._entries) {
          if (droppedTaskIds.has(e.taskId)) this._entries.delete(eid);
        }
        return;
      }

      case "task.create":
        this._tasks.set(op.id, {
          id: op.id,
          chatSessionId: op.chatSessionId,
          agentSessionId: op.agentSessionId,
          status: op.status,
          modelId: op.modelId,
          toolCallMode: op.toolCallMode,
          thinkLevel: op.thinkLevel,
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          toolCallCount: 0,
          iterationCount: 0,
          finalResult: "",
          errorMessage: null,
          createdAt: op.createdAt,
          updatedAt: op.updatedAt,
        });
        this.bumpId(op.id);
        return;

      case "task.update": {
        const existing = this._tasks.get(op.id);
        if (!existing) return;
        const next: TaskRow = { ...existing, updatedAt: op.updatedAt };
        const p = op.patch;
        if (p.status !== undefined) next.status = p.status;
        if (p.finalResult !== undefined) next.finalResult = p.finalResult;
        if (p.promptTokens !== undefined) next.promptTokens = p.promptTokens;
        if (p.completionTokens !== undefined) next.completionTokens = p.completionTokens;
        if (p.totalTokens !== undefined) next.totalTokens = p.totalTokens;
        if (p.toolCallCount !== undefined) next.toolCallCount = p.toolCallCount;
        if (p.iterationCount !== undefined) next.iterationCount = p.iterationCount;
        if (p.errorMessage !== undefined) next.errorMessage = p.errorMessage;
        this._tasks.set(op.id, next);
        return;
      }

      case "entry.append":
        this._entries.set(op.id, {
          id: op.id,
          taskId: op.taskId,
          sessionId: op.sessionId,
          sessionType: op.sessionType,
          kind: op.kind,
          role: op.role,
          content: op.content,
          toolCallId: op.toolCallId,
          thinking: op.thinking,
          metadata: op.metadata,
          createdAt: op.createdAt,
        });
        this.bumpId(op.id);
        return;

      case "entry.update": {
        const existing = this._entries.get(op.id);
        if (!existing) return;
        const next: EntryRow = { ...existing };
        const p = op.patch;
        if (p.content !== undefined) next.content = p.content;
        if (p.metadata !== undefined) {
          if (p.mergeMetadata) {
            next.metadata = { ...(existing.metadata ?? {}), ...p.metadata };
          } else {
            next.metadata = p.metadata;
          }
        }
        this._entries.set(op.id, next);
        return;
      }

      case "provider.create":
        this._providers.set(op.id, {
          id: op.id,
          name: op.name,
          protocol: op.protocol,
          baseUrl: op.baseUrl,
          apiKey: op.apiKey,
          defaultHeaders: op.defaultHeaders,
          createdAt: op.createdAt,
        });
        this.bumpId(op.id);
        return;

      case "provider.update": {
        const existing = this._providers.get(op.id);
        if (!existing) return;
        const next: ProviderRow = { ...existing };
        const p = op.patch;
        if (p.name !== undefined) next.name = p.name;
        if (p.protocol !== undefined) next.protocol = p.protocol;
        if (p.baseUrl !== undefined) next.baseUrl = p.baseUrl;
        if (p.apiKey !== undefined) next.apiKey = p.apiKey;
        if (p.defaultHeaders !== undefined) next.defaultHeaders = p.defaultHeaders;
        this._providers.set(op.id, next);
        return;
      }

      case "provider.delete":
        this._providers.delete(op.id);
        // cascade: drop models referencing this provider
        for (const [mid, m] of this._models) {
          if (m.providerId === op.id) this._models.delete(mid);
        }
        return;

      case "model.create":
        this._models.set(op.id, {
          id: op.id,
          providerId: op.providerId,
          modelId: op.modelId,
          displayName: op.displayName,
          defaultThinkLevel: op.defaultThinkLevel,
          defaultToolCallMode: op.defaultToolCallMode,
          createdAt: op.createdAt,
        });
        this.bumpId(op.id);
        return;

      case "model.delete":
        this._models.delete(op.id);
        return;

      case "config.set":
        this._config.set(op.key, {
          key: op.key,
          value: op.value,
          updatedAt: op.updatedAt,
        });
        return;
    }
  }

  private bumpId(seenId: number): void {
    if (seenId >= this.nextId) this.nextId = seenId + 1;
  }

  private entriesForSession(sessionId: number, type: SessionType): EntryRow[] {
    const out: EntryRow[] = [];
    for (const r of this._entries.values()) {
      if (r.sessionId === sessionId && r.sessionType === type) out.push(r);
    }
    return out.sort((a, b) => a.id - b.id);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function projectToLLMMessage(r: EntryRow): LLMMessage | null {
  if (!isLLMVisible(r.kind as EntryKind)) return null;
  const meta = r.metadata as Record<string, unknown> | null;
  const toolCalls = meta?.["toolCalls"] as ToolCall[] | undefined;
  return {
    role: r.role,
    content: r.content,
    ...(toolCalls && toolCalls.length > 0 ? { toolCalls } : {}),
    ...(r.toolCallId ? { toolCallId: r.toolCallId } : {}),
    ...(r.thinking ? { thinking: r.thinking } : {}),
    _entryId: r.id,
  };
}
