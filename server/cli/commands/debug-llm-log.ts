/**
 * server/cli/commands/debug-llm-log.ts
 *
 * `huko debug llm-log` — render the current session's LLM calls into a
 * reader-friendly HTML report.
 *
 * Why this exists: when a task misbehaves, the only useful artefact is
 * the actual sequence of (system + history) → (assistant response) round
 * trips. The DB has all the raw entries; this command turns them into a
 * page you open in a browser to follow the conversation, see each call's
 * delta vs the previous call, and inspect tool_calls / tool_results /
 * thinking / usage at a glance.
 *
 * Per-task vs per-call:
 *   - One task = one row in `tasks` table.
 *   - One LLM call = one assistant entry (`kind=ai_message`). The inputs
 *     to that call were: system_prompt + every LLM-visible entry up to
 *     (but not including) that ai_message.
 *
 * Delta display: for the second and subsequent LLM calls within a task,
 * we only render the entries added since the previous call (which is
 * usually the previous assistant turn + tool_results + maybe a
 * system_reminder + maybe an interjected user message). Saves a ton of
 * scrolling.
 *
 * Output is `<cwd>/huko_llm_log.html`. We stamp a "generated at" header
 * and never overwrite without the user knowing — the path is the only
 * place we write to.
 *
 * No HTML libraries. The renderer is plain template strings + a small
 * escapeHtml; pure ESM, no deps.
 */

import { writeFileSync } from "node:fs";
import * as path from "node:path";
import { existsSync } from "node:fs";
import {
  SqliteSessionPersistence,
  type SessionPersistence,
} from "../../persistence/index.js";
import type { ChatSessionRow, EntryRow, TaskRow } from "../../persistence/types.js";
import { getActiveSessionId } from "../state.js";

export type DebugLlmLogArgs = {
  /** Session id to dump. When omitted, falls back to the active session. */
  sessionId?: number;
  /** Output path. Defaults to `<cwd>/huko_llm_log.html`. */
  outPath?: string;
};

// ─── Public command entry ───────────────────────────────────────────────────

export async function debugLlmLogCommand(args: DebugLlmLogArgs): Promise<number> {
  const cwd = process.cwd();

  if (!hasSessionDb(cwd)) {
    process.stderr.write(
      "huko debug llm-log: no .huko/huko.db in this directory; nothing to dump.\n",
    );
    return 4;
  }

  const sessionId = args.sessionId ?? getActiveSessionId(cwd);
  if (sessionId === null || sessionId === undefined) {
    process.stderr.write(
      "huko debug llm-log: no active session in this directory; pass --session=<id> or run `huko sessions switch <id>` first.\n",
    );
    return 4;
  }

  let persistence: SessionPersistence | null = null;
  try {
    persistence = new SqliteSessionPersistence();

    const session = await persistence.sessions.get(sessionId);
    if (!session) {
      process.stderr.write(`huko debug llm-log: session ${sessionId} not found.\n`);
      return 4;
    }

    const entries = await persistence.entries.listForSession(sessionId, "chat");
    const tasks = await collectTasks(persistence, entries);

    const html = renderLlmLogHtml({
      session,
      tasks,
      entries,
      generatedAt: new Date(),
    });

    const outPath = args.outPath ?? path.join(cwd, "huko_llm_log.html");
    writeFileSync(outPath, html, "utf8");

    const callCount = entries.filter((e) => e.kind === "ai_message").length;
    process.stdout.write(
      `huko debug llm-log: wrote ${callCount} LLM call(s) across ${tasks.length} task(s) → ${outPath}\n`,
    );
    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`huko debug llm-log: ${msg}\n`);
    return 1;
  } finally {
    if (persistence) {
      try {
        await persistence.close();
      } catch {
        /* swallow */
      }
    }
  }
}

// ─── Pure render layer (exported for tests) ────────────────────────────────

export type RenderInput = {
  session: ChatSessionRow;
  tasks: TaskRow[];
  entries: EntryRow[];
  generatedAt: Date;
};

/**
 * Compose the entire HTML document. Pure function — no I/O.
 * Walks entries grouping by task, then within each task identifies LLM
 * call points (one per `ai_message`) and renders inputs as deltas.
 */
export function renderLlmLogHtml(input: RenderInput): string {
  const { session, tasks, entries, generatedAt } = input;

  const taskById = new Map<number, TaskRow>();
  for (const t of tasks) taskById.set(t.id, t);

  // Group entries by task, preserving order.
  const entriesByTask = new Map<number, EntryRow[]>();
  for (const e of entries) {
    const arr = entriesByTask.get(e.taskId);
    if (arr) arr.push(e);
    else entriesByTask.set(e.taskId, [e]);
  }

  const taskHtml: string[] = [];
  // Render in task-id order so the page reads chronologically.
  const orderedTaskIds = [...entriesByTask.keys()].sort((a, b) => a - b);
  for (const taskId of orderedTaskIds) {
    const task = taskById.get(taskId);
    const taskEntries = entriesByTask.get(taskId) ?? [];
    taskHtml.push(renderTask(task ?? null, taskEntries));
  }

  return wrapDocument({
    title: `huko LLM log — ${session.title || `session #${session.id}`}`,
    header: renderTopHeader(session, tasks.length, entries, generatedAt),
    body: taskHtml.join("\n"),
  });
}

// ─── Layout helpers ────────────────────────────────────────────────────────

function renderTopHeader(
  session: ChatSessionRow,
  taskCount: number,
  entries: EntryRow[],
  generatedAt: Date,
): string {
  const callCount = entries.filter((e) => e.kind === "ai_message").length;
  const totals = sumUsage(entries);
  return `
<header class="page-header">
  <h1>huko LLM log</h1>
  <dl class="meta">
    <dt>Session</dt><dd>#${session.id}${session.title ? ` — ${escapeHtml(session.title)}` : ""}</dd>
    <dt>Tasks</dt><dd>${taskCount}</dd>
    <dt>LLM calls</dt><dd>${callCount}</dd>
    <dt>Total tokens</dt><dd>${totals.total} <span class="dim">(${totals.prompt} prompt + ${totals.completion} completion)</span></dd>
    <dt>Generated</dt><dd>${escapeHtml(generatedAt.toISOString())}</dd>
  </dl>
</header>`.trim();
}

function renderTask(task: TaskRow | null, entries: EntryRow[]): string {
  if (entries.length === 0) return "";
  const taskId = entries[0]!.taskId;

  // Find LLM call boundaries (each ai_message is the response of one call).
  // For each call, slice the inputs that came BEFORE this ai_message in
  // task order. The system_prompt entry, if persisted, is the same for
  // all calls; we extract it once and render collapsibly.
  const systemPromptEntry = entries.find((e) => e.kind === "system_prompt");

  // Filter to LLM-visible entries for the input-history reconstruction.
  // tool_call entries are an artefact of the assistant turn; we render
  // them under that turn rather than as standalone history rows. So
  // for "input history" we exclude ai_message itself (it's the call
  // we're rendering) and tool_call rows (folded into the prior assistant).
  const callIndices: number[] = [];
  for (let i = 0; i < entries.length; i++) {
    if (entries[i]!.kind === "ai_message") callIndices.push(i);
  }

  const callsHtml: string[] = [];
  let prevCallEndIdx = -1;
  for (let n = 0; n < callIndices.length; n++) {
    const idx = callIndices[n]!;
    const callEntry = entries[idx]!;
    // Inputs since the previous call's boundary (exclusive of the current
    // ai_message itself).
    const newInputs = entries
      .slice(prevCallEndIdx + 1, idx)
      // Don't echo the system_prompt as a history row — it's surfaced
      // separately at the top of the task block.
      .filter((e) => e.kind !== "system_prompt");
    callsHtml.push(renderCall({ index: n + 1, callEntry, newInputs, isFirst: n === 0 }));
    prevCallEndIdx = idx;
  }

  // Trailing tool_results / reminders after the last LLM call (these
  // were inputs to a call that hasn't happened yet, or are leftover
  // from a task that ended right after a tool).
  const tail = entries.slice(prevCallEndIdx + 1).filter((e) => e.kind !== "system_prompt");
  const tailHtml =
    tail.length > 0
      ? `<section class="trailing-entries">
          <h4>After the last LLM response</h4>
          ${tail.map((e) => renderEntry(e)).join("\n")}
         </section>`
      : "";

  const taskBadge = task
    ? `<span class="badge status-${escapeAttr(task.status)}">${escapeHtml(task.status)}</span>` +
      `<span class="badge model">${escapeHtml(task.modelId)}</span>` +
      `<span class="badge dim">${task.totalTokens} tok · ${task.toolCallCount} tool calls · ${task.iterationCount} iters</span>`
    : "";

  const sysHtml = systemPromptEntry
    ? `<details class="system-prompt"><summary>System prompt (${systemPromptEntry.content.length} chars)</summary>
        <pre>${escapeHtml(systemPromptEntry.content)}</pre>
      </details>`
    : "";

  return `
<section class="task" id="task-${taskId}">
  <header class="task-header">
    <h2>Task #${taskId}</h2>
    ${taskBadge}
  </header>
  ${sysHtml}
  ${callsHtml.join("\n")}
  ${tailHtml}
</section>`.trim();
}

function renderCall(opts: {
  index: number;
  callEntry: EntryRow;
  newInputs: EntryRow[];
  isFirst: boolean;
}): string {
  const { index, callEntry, newInputs, isFirst } = opts;
  const meta = (callEntry.metadata ?? {}) as Record<string, unknown>;
  const usage = isUsage(meta["usage"]) ? meta["usage"] : null;
  const thinking =
    typeof meta["thinking"] === "string" && (meta["thinking"] as string).length > 0
      ? (meta["thinking"] as string)
      : callEntry.thinking ?? "";
  const toolCalls = Array.isArray(meta["toolCalls"]) ? meta["toolCalls"] : [];

  const inputsHtml =
    newInputs.length > 0
      ? `<div class="call-inputs">
          <h4>${isFirst ? "Inputs" : "Inputs (delta since previous call)"}</h4>
          ${newInputs.map((e) => renderEntry(e)).join("\n")}
         </div>`
      : `<div class="call-inputs empty"><h4>${isFirst ? "Inputs" : "Inputs (delta since previous call)"}</h4><p class="dim">(no new entries since previous call)</p></div>`;

  const usageBadge = usage
    ? `<span class="badge dim">${usage.totalTokens} tok</span>`
    : "";

  const thinkingHtml = thinking
    ? `<details class="thinking"><summary>Thinking (${thinking.length} chars)</summary>
        <pre>${escapeHtml(thinking)}</pre>
       </details>`
    : "";

  const contentHtml =
    callEntry.content && callEntry.content.length > 0
      ? `<div class="assistant-content"><pre>${escapeHtml(callEntry.content)}</pre></div>`
      : "";

  const toolCallsHtml =
    toolCalls.length > 0
      ? `<div class="tool-calls">
          <h5>Tool calls (${toolCalls.length})</h5>
          ${toolCalls.map((tc) => renderToolCall(tc as unknown)).join("\n")}
         </div>`
      : "";

  const usageDetail = usage
    ? `<div class="usage dim">prompt=${usage.promptTokens} · completion=${usage.completionTokens} · total=${usage.totalTokens}</div>`
    : "";

  return `
<article class="llm-call">
  <header class="call-header">
    <h3>LLM call #${index}</h3>
    ${usageBadge}
  </header>
  ${inputsHtml}
  <div class="call-output">
    <h4>Assistant response</h4>
    ${thinkingHtml}
    ${contentHtml}
    ${toolCallsHtml}
    ${usageDetail}
  </div>
</article>`.trim();
}

function renderEntry(entry: EntryRow): string {
  switch (entry.kind) {
    case "user_message":
      return `<div class="entry user"><span class="role">user</span><pre>${escapeHtml(entry.content)}</pre></div>`;
    case "ai_message": {
      // Should rarely appear here — calls are folded above. Render a compact summary.
      return `<div class="entry assistant"><span class="role">assistant</span><pre>${escapeHtml(entry.content || "(empty)")}</pre></div>`;
    }
    case "tool_result": {
      const meta = (entry.metadata ?? {}) as Record<string, unknown>;
      const toolName =
        typeof meta["toolName"] === "string" ? (meta["toolName"] as string) : "(unknown)";
      const errored = typeof meta["error"] === "string" && (meta["error"] as string).length > 0;
      const argsHtml = renderToolArgs(meta["arguments"]);
      const cls = errored ? "entry tool-result error" : "entry tool-result";
      return `<div class="${cls}">
        <span class="role">tool</span>
        <span class="tool-name">${escapeHtml(toolName)}</span>
        ${argsHtml}
        <pre>${escapeHtml(entry.content)}</pre>
      </div>`;
    }
    case "tool_call": {
      // tool_call rows that survived as standalone entries — shouldn't
      // happen in current code (we fold them under the assistant turn),
      // but render defensively.
      return `<div class="entry tool-call"><span class="role">tool_call</span><pre>${escapeHtml(entry.content)}</pre></div>`;
    }
    case "system_reminder":
      return `<div class="entry reminder"><span class="role">system_reminder</span><pre>${escapeHtml(entry.content)}</pre></div>`;
    case "status_notice":
      return `<div class="entry status"><span class="role">status</span><pre>${escapeHtml(entry.content)}</pre></div>`;
    case "system_prompt":
      // Should be filtered out before reaching here; defensive.
      return `<div class="entry system"><span class="role">system_prompt</span><pre>${escapeHtml(entry.content.slice(0, 200))}…</pre></div>`;
    default:
      return `<div class="entry unknown"><span class="role">${escapeHtml(entry.kind)}</span><pre>${escapeHtml(entry.content)}</pre></div>`;
  }
}

function renderToolCall(tc: unknown): string {
  if (!tc || typeof tc !== "object") return "";
  const obj = tc as Record<string, unknown>;
  const name = typeof obj["name"] === "string" ? (obj["name"] as string) : "(unnamed)";
  const args = obj["arguments"];
  return `<div class="tool-call-block">
    <span class="tool-name">${escapeHtml(name)}</span>
    <pre>${escapeHtml(prettyJson(args))}</pre>
  </div>`;
}

function renderToolArgs(args: unknown): string {
  if (args === undefined || args === null) return "";
  const json = prettyJson(args);
  if (json === "{}" || json === "null") return "";
  return `<details class="tool-args"><summary>arguments</summary><pre>${escapeHtml(json)}</pre></details>`;
}

// ─── Persistence helpers ───────────────────────────────────────────────────

async function collectTasks(
  persistence: SessionPersistence,
  entries: EntryRow[],
): Promise<TaskRow[]> {
  const ids = new Set<number>();
  for (const e of entries) ids.add(e.taskId);
  const out: TaskRow[] = [];
  for (const id of [...ids].sort((a, b) => a - b)) {
    const row = await persistence.tasks.get(id);
    if (row) out.push(row);
  }
  return out;
}

function hasSessionDb(cwd: string): boolean {
  return existsSync(path.join(cwd, ".huko", "huko.db"));
}

// ─── Tiny utilities ────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function prettyJson(x: unknown): string {
  try {
    return JSON.stringify(x, null, 2);
  } catch {
    return String(x);
  }
}

function sumUsage(entries: EntryRow[]): {
  prompt: number;
  completion: number;
  total: number;
} {
  let prompt = 0, completion = 0, total = 0;
  for (const e of entries) {
    if (e.kind !== "ai_message") continue;
    const u = (e.metadata as Record<string, unknown> | null)?.["usage"];
    if (!isUsage(u)) continue;
    prompt += u.promptTokens;
    completion += u.completionTokens;
    total += u.totalTokens;
  }
  return { prompt, completion, total };
}

function isUsage(x: unknown): x is { promptTokens: number; completionTokens: number; totalTokens: number } {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o["promptTokens"] === "number" &&
    typeof o["completionTokens"] === "number" &&
    typeof o["totalTokens"] === "number"
  );
}

// ─── Document wrapper + stylesheet ─────────────────────────────────────────

function wrapDocument(opts: { title: string; header: string; body: string }): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(opts.title)}</title>
<style>${STYLES}</style>
</head>
<body>
${opts.header}
${opts.body}
</body>
</html>
`;
}

const STYLES = `
:root {
  color-scheme: light dark;
  --fg: #1e1e1e;
  --bg: #fafafa;
  --muted: #6b7280;
  --border: #d4d4d8;
  --accent: #2563eb;
  --user-bg: #e0f2fe;
  --user-fg: #0c4a6e;
  --assistant-bg: #dcfce7;
  --assistant-fg: #14532d;
  --tool-bg: #f1f5f9;
  --tool-fg: #1e293b;
  --tool-error-bg: #fee2e2;
  --tool-error-fg: #991b1b;
  --reminder-bg: #fef3c7;
  --reminder-fg: #78350f;
  --status-bg: #f1f5f9;
  --status-fg: #475569;
  --tool-call-bg: #fed7aa;
  --tool-call-fg: #9a3412;
  --task-band: #2563eb;
}
@media (prefers-color-scheme: dark) {
  :root {
    --fg: #e5e5e5;
    --bg: #0f1115;
    --muted: #9ca3af;
    --border: #2d2f36;
    --user-bg: #0c4a6e;
    --user-fg: #cffafe;
    --assistant-bg: #14532d;
    --assistant-fg: #d1fae5;
    --tool-bg: #1e293b;
    --tool-fg: #cbd5e1;
    --tool-error-bg: #7f1d1d;
    --tool-error-fg: #fee2e2;
    --reminder-bg: #78350f;
    --reminder-fg: #fef3c7;
    --status-bg: #1e293b;
    --status-fg: #cbd5e1;
    --tool-call-bg: #9a3412;
    --tool-call-fg: #fed7aa;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, sans-serif;
  font-size: 14px;
  line-height: 1.5;
  color: var(--fg);
  background: var(--bg);
  padding: 1.5rem 2rem 4rem;
  max-width: 1100px;
  margin: 0 auto;
}
pre {
  margin: 0.25rem 0 0 0;
  padding: 0.5rem 0.75rem;
  background: rgba(0,0,0,0.04);
  border-radius: 4px;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: "SF Mono", Menlo, Consolas, monospace;
  font-size: 12.5px;
  overflow-x: auto;
}
@media (prefers-color-scheme: dark) {
  pre { background: rgba(255,255,255,0.04); }
}
h1 { font-size: 1.5rem; margin: 0 0 0.5rem; }
h2 { font-size: 1.25rem; margin: 0; }
h3 { font-size: 1.05rem; margin: 0.25rem 0; }
h4 { font-size: 0.95rem; margin: 0.5rem 0 0.25rem; color: var(--muted); }
h5 { font-size: 0.9rem; margin: 0.5rem 0 0.25rem; color: var(--muted); }
.dim { color: var(--muted); }

/* page header */
.page-header {
  border-bottom: 1px solid var(--border);
  padding-bottom: 1rem;
  margin-bottom: 1.5rem;
}
.page-header dl.meta {
  display: grid;
  grid-template-columns: max-content 1fr;
  column-gap: 1rem;
  row-gap: 0.25rem;
  margin: 0;
}
.page-header dt { font-weight: 600; color: var(--muted); }
.page-header dd { margin: 0; }

/* task block */
.task {
  border: 1px solid var(--border);
  border-left: 4px solid var(--task-band);
  border-radius: 6px;
  padding: 1rem 1.25rem;
  margin: 0 0 1.5rem;
  background: var(--bg);
}
.task-header {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  flex-wrap: wrap;
  margin-bottom: 0.6rem;
}
.badge {
  display: inline-block;
  padding: 0.1rem 0.5rem;
  border-radius: 999px;
  font-size: 0.78rem;
  background: var(--tool-bg);
  color: var(--tool-fg);
}
.badge.status-done    { background: var(--assistant-bg); color: var(--assistant-fg); }
.badge.status-failed  { background: var(--tool-error-bg); color: var(--tool-error-fg); }
.badge.status-stopped { background: var(--reminder-bg);  color: var(--reminder-fg); }
.badge.model { background: var(--user-bg); color: var(--user-fg); }
.badge.dim   { background: transparent; color: var(--muted); padding-left: 0; }

/* system prompt collapsible */
.system-prompt {
  margin: 0.5rem 0 1rem;
}
.system-prompt summary {
  cursor: pointer;
  color: var(--muted);
  font-size: 0.9rem;
  user-select: none;
}

/* one LLM call */
.llm-call {
  margin: 1rem 0 0;
  padding-top: 0.6rem;
  border-top: 1px dashed var(--border);
}
.llm-call:first-of-type { border-top: none; padding-top: 0; }
.call-header {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  margin-bottom: 0.4rem;
}
.call-inputs.empty p { font-style: italic; }

/* entries */
.entry {
  display: block;
  padding: 0.5rem 0.75rem;
  border-radius: 4px;
  margin: 0.25rem 0;
  border: 1px solid var(--border);
}
.entry .role {
  display: inline-block;
  font-size: 0.78rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  margin-right: 0.5rem;
  color: var(--muted);
}
.entry .tool-name {
  display: inline-block;
  font-family: "SF Mono", Menlo, Consolas, monospace;
  font-size: 0.85rem;
  background: var(--tool-call-bg);
  color: var(--tool-call-fg);
  padding: 0.05rem 0.4rem;
  border-radius: 3px;
  margin-right: 0.4rem;
}
.entry.user           { background: var(--user-bg);     color: var(--user-fg); border-color: transparent; }
.entry.assistant      { background: var(--assistant-bg); color: var(--assistant-fg); border-color: transparent; }
.entry.tool-result    { background: var(--tool-bg);     color: var(--tool-fg); border-color: transparent; }
.entry.tool-result.error { background: var(--tool-error-bg); color: var(--tool-error-fg); }
.entry.tool-call      { background: var(--tool-call-bg); color: var(--tool-call-fg); border-color: transparent; }
.entry.reminder       { background: var(--reminder-bg); color: var(--reminder-fg); border-color: transparent; }
.entry.status         { background: var(--status-bg);   color: var(--status-fg); border-color: transparent; }
.entry.unknown        { background: transparent; }

.tool-args summary { cursor: pointer; color: var(--muted); font-size: 0.85rem; }
.tool-args[open] { margin-top: 0.25rem; }

/* assistant response */
.call-output {
  background: var(--assistant-bg);
  color: var(--assistant-fg);
  border-radius: 4px;
  padding: 0.5rem 0.75rem;
  margin-top: 0.4rem;
}
.call-output h4 {
  margin: 0 0 0.4rem;
  color: var(--assistant-fg);
  opacity: 0.9;
}
.call-output pre { background: rgba(0,0,0,0.05); }
.thinking summary { cursor: pointer; color: var(--muted); font-size: 0.85rem; }
.tool-calls h5 { color: var(--assistant-fg); opacity: 0.9; }
.tool-call-block {
  margin: 0.25rem 0;
  padding: 0.3rem 0.5rem;
  border-radius: 4px;
  background: var(--tool-call-bg);
  color: var(--tool-call-fg);
}
.usage { margin-top: 0.5rem; font-size: 0.78rem; }

/* trailing entries */
.trailing-entries { margin-top: 1rem; padding-top: 0.6rem; border-top: 1px dashed var(--border); }
`.trim();
