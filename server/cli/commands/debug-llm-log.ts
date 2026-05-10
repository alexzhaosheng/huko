/**
 * server/cli/commands/debug-llm-log.ts
 *
 * `huko debug llm-log` — render the current session's LLM calls into a
 * reader-friendly HTML report.
 *
 * Per call we render:
 *   - inputs delta (entries new since previous call)
 *   - assistant response (content / thinking / tool_calls / usage)
 *   - "View raw payload" button → opens a <dialog> showing the JSON
 *     `{model, messages: [...], tools?: [...]}` shape that the OpenAI
 *     adapter would have sent. Built by reconstructing from the
 *     persisted system_prompt + every LLM-visible entry up to this call.
 *
 * Output is `<cwd>/huko_llm_log.html`.
 */

import { writeFileSync, existsSync } from "node:fs";
import * as path from "node:path";
import {
  SqliteSessionPersistence,
  type SessionPersistence,
} from "../../persistence/index.js";
import type { ChatSessionRow, EntryRow, TaskRow } from "../../persistence/types.js";
import { getActiveSessionId } from "../state.js";

export type DebugLlmLogArgs = {
  sessionId?: number;
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
      `huko debug llm-log: wrote ${callCount} LLM call(s) across ${tasks.length} task(s) -> ${outPath}\n`,
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

export function renderLlmLogHtml(input: RenderInput): string {
  const { session, tasks, entries, generatedAt } = input;

  const taskById = new Map<number, TaskRow>();
  for (const t of tasks) taskById.set(t.id, t);

  const entriesByTask = new Map<number, EntryRow[]>();
  for (const e of entries) {
    const arr = entriesByTask.get(e.taskId);
    if (arr) arr.push(e);
    else entriesByTask.set(e.taskId, [e]);
  }

  const taskHtml: string[] = [];
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

  const systemPromptEntry = entries.find((e) => e.kind === "system_prompt");

  const callIndices: number[] = [];
  for (let i = 0; i < entries.length; i++) {
    if (entries[i]!.kind === "ai_message") callIndices.push(i);
  }

  const callsHtml: string[] = [];
  let prevCallEndIdx = -1;
  for (let n = 0; n < callIndices.length; n++) {
    const idx = callIndices[n]!;
    const callEntry = entries[idx]!;
    const newInputs = entries
      .slice(prevCallEndIdx + 1, idx)
      .filter((e) => e.kind !== "system_prompt");

    // Reconstruct the raw OpenAI-shaped payload for THIS call: the
    // system prompt (if persisted) + every LLM-visible entry strictly
    // before this ai_message + the tools array (if known). We don't
    // persist the tools list, so we omit it here and the dialog notes
    // that the tools array is unknown.
    const historyBeforeCall = entries.slice(0, idx);
    const rawPayload = buildRawPayload({
      task,
      systemPromptEntry: systemPromptEntry ?? null,
      historyEntries: historyBeforeCall,
    });

    callsHtml.push(
      renderCall({
        index: n + 1,
        callEntry,
        newInputs,
        isFirst: n === 0,
        rawPayload,
        dialogId: `payload-task${taskId}-call${n + 1}`,
      }),
    );
    prevCallEndIdx = idx;
  }

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
    : `<p class="dim system-prompt-missing">(System prompt not persisted for this task — older session?)</p>`;

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
  rawPayload: RawPayload;
  dialogId: string;
}): string {
  const { index, callEntry, newInputs, isFirst, rawPayload, dialogId } = opts;
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

  const rawBtn = `<button type="button" class="raw-btn" data-dialog="${escapeAttr(dialogId)}">View raw payload</button>`;

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

  const dialogHtml = renderPayloadDialog(dialogId, rawPayload, index);

  return `
<article class="llm-call">
  <header class="call-header">
    <h3>LLM call #${index}</h3>
    ${usageBadge}
    ${rawBtn}
  </header>
  ${inputsHtml}
  <div class="call-output">
    <h4>Assistant response</h4>
    ${thinkingHtml}
    ${contentHtml}
    ${toolCallsHtml}
    ${usageDetail}
  </div>
  ${dialogHtml}
</article>`.trim();
}

function renderEntry(entry: EntryRow): string {
  switch (entry.kind) {
    case "user_message":
      return `<div class="entry user"><span class="role">user</span><pre>${escapeHtml(entry.content)}</pre></div>`;
    case "ai_message": {
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
      return `<div class="entry tool-call"><span class="role">tool_call</span><pre>${escapeHtml(entry.content)}</pre></div>`;
    }
    case "system_reminder":
      return `<div class="entry reminder"><span class="role">system_reminder</span><pre>${escapeHtml(entry.content)}</pre></div>`;
    case "status_notice":
      return `<div class="entry status"><span class="role">status</span><pre>${escapeHtml(entry.content)}</pre></div>`;
    case "system_prompt":
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

// ─── Raw payload reconstruction + dialog ───────────────────────────────────

export type RawPayload = {
  /** Modelled on the OpenAI Chat Completions request body shape. */
  model: string | null;
  messages: Array<Record<string, unknown>>;
  /**
   * Note rendered in the dialog explaining what we DON'T know
   * (e.g. tools array, sampling params). Helps the reader avoid
   * mistaking the reconstruction for a literal HTTP capture.
   */
  notes: string[];
};

/**
 * Rebuild the OpenAI-shaped messages payload for a given LLM call.
 * Pure: takes the system prompt entry + the history entries that
 * preceded the call and folds them into `{role, content, ...}` shapes
 * compatible with OpenAI Chat Completions / most compatible servers.
 *
 * Exported for tests so the reconstruction can be pinned independently
 * of the rendering layer.
 */
export function buildRawPayload(opts: {
  task: TaskRow | null;
  systemPromptEntry: EntryRow | null;
  historyEntries: EntryRow[];
}): RawPayload {
  const { task, systemPromptEntry, historyEntries } = opts;
  const messages: Array<Record<string, unknown>> = [];

  if (systemPromptEntry) {
    messages.push({
      role: "system",
      content: systemPromptEntry.content,
    });
  }

  for (const e of historyEntries) {
    if (e.kind === "system_prompt") continue; // already handled
    if (e.kind === "status_notice") continue; // not LLM-visible
    if (e.kind === "tool_call") continue;     // folded into ai_message metadata

    if (e.kind === "user_message") {
      messages.push({ role: "user", content: e.content });
      continue;
    }

    if (e.kind === "ai_message") {
      const meta = (e.metadata ?? {}) as Record<string, unknown>;
      const toolCalls = Array.isArray(meta["toolCalls"]) ? meta["toolCalls"] : [];
      const msg: Record<string, unknown> = {
        role: "assistant",
        content: e.content,
      };
      if (toolCalls.length > 0) {
        msg["tool_calls"] = toolCalls.map((tc) => {
          const o = tc as Record<string, unknown>;
          return {
            id: typeof o["id"] === "string" ? o["id"] : "",
            type: "function",
            function: {
              name: typeof o["name"] === "string" ? o["name"] : "",
              arguments: prettyJson(o["arguments"] ?? {}),
            },
          };
        });
      }
      messages.push(msg);
      continue;
    }

    if (e.kind === "tool_result") {
      messages.push({
        role: "tool",
        tool_call_id: e.toolCallId ?? "",
        content: e.content,
      });
      continue;
    }

    if (e.kind === "system_reminder") {
      // SessionContext.appendReminder persists with role="user"; the
      // wire shape is the same.
      messages.push({ role: "user", content: e.content });
      continue;
    }
  }

  const notes: string[] = [];
  if (!systemPromptEntry) {
    notes.push(
      "system_prompt not persisted for this task — the actual prompt was passed to the provider but is missing from the DB. Older session?",
    );
  }
  notes.push(
    "Reconstructed from persisted entries. The `tools` array, sampling params, and provider-specific options are not recorded and therefore omitted here.",
  );

  return {
    model: task?.modelId ?? null,
    messages,
    notes,
  };
}

function renderPayloadDialog(
  dialogId: string,
  payload: RawPayload,
  callIndex: number,
): string {
  const obj: Record<string, unknown> = { messages: payload.messages };
  if (payload.model !== null) obj["model"] = payload.model;
  const json = prettyJson(obj);

  const notesHtml = payload.notes
    .map((n) => `<li>${escapeHtml(n)}</li>`)
    .join("");

  return `
<dialog class="raw-dialog" id="${escapeAttr(dialogId)}">
  <div class="raw-dialog-inner">
    <header class="raw-dialog-header">
      <strong>Raw payload — call #${callIndex}</strong>
      <button type="button" class="raw-dialog-close" data-close="${escapeAttr(dialogId)}" aria-label="Close">×</button>
    </header>
    <ul class="raw-dialog-notes">${notesHtml}</ul>
    <pre class="raw-dialog-json">${escapeHtml(json)}</pre>
  </div>
</dialog>`.trim();
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

// ─── Document wrapper + stylesheet + tiny dialog script ───────────────────

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
<script>${DIALOG_SCRIPT}</script>
</body>
</html>
`;
}

const DIALOG_SCRIPT = `
(function() {
  function bind() {
    document.querySelectorAll('button.raw-btn').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var id = btn.getAttribute('data-dialog');
        var dlg = document.getElementById(id);
        if (dlg && typeof dlg.showModal === 'function') {
          dlg.showModal();
        } else if (dlg) {
          // Old browsers without <dialog> — fall back to display: block
          dlg.setAttribute('open', '');
        }
      });
    });
    document.querySelectorAll('button.raw-dialog-close').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var id = btn.getAttribute('data-close');
        var dlg = document.getElementById(id);
        if (dlg && typeof dlg.close === 'function') {
          dlg.close();
        } else if (dlg) {
          dlg.removeAttribute('open');
        }
      });
    });
    // Click on backdrop closes too.
    document.querySelectorAll('dialog.raw-dialog').forEach(function(dlg) {
      dlg.addEventListener('click', function(ev) {
        if (ev.target === dlg) {
          if (typeof dlg.close === 'function') dlg.close();
          else dlg.removeAttribute('open');
        }
      });
    });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bind);
  } else {
    bind();
  }
})();
`.trim();

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

.system-prompt { margin: 0.5rem 0 1rem; }
.system-prompt summary {
  cursor: pointer;
  color: var(--muted);
  font-size: 0.9rem;
  user-select: none;
}
.system-prompt-missing { font-size: 0.85rem; margin: 0.25rem 0 1rem; }

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

button.raw-btn {
  margin-left: auto;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--accent);
  font-size: 0.8rem;
  padding: 0.15rem 0.6rem;
  border-radius: 4px;
  cursor: pointer;
}
button.raw-btn:hover {
  background: rgba(37, 99, 235, 0.1);
}

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

.trailing-entries { margin-top: 1rem; padding-top: 0.6rem; border-top: 1px dashed var(--border); }

/* dialog */
dialog.raw-dialog {
  max-width: 90vw;
  width: 900px;
  max-height: 85vh;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 0;
  background: var(--bg);
  color: var(--fg);
}
dialog.raw-dialog::backdrop {
  background: rgba(0, 0, 0, 0.45);
}
.raw-dialog-inner {
  display: flex;
  flex-direction: column;
  max-height: 85vh;
}
.raw-dialog-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.6rem 1rem;
  border-bottom: 1px solid var(--border);
  background: var(--tool-bg);
  color: var(--tool-fg);
}
.raw-dialog-close {
  border: none;
  background: transparent;
  font-size: 1.4rem;
  cursor: pointer;
  color: var(--muted);
  line-height: 1;
  padding: 0 0.3rem;
}
.raw-dialog-close:hover { color: var(--fg); }
.raw-dialog-notes {
  margin: 0;
  padding: 0.5rem 1.5rem;
  font-size: 0.78rem;
  color: var(--muted);
  border-bottom: 1px solid var(--border);
}
.raw-dialog-notes li { margin: 0.15rem 0; }
.raw-dialog-json {
  margin: 0;
  border-radius: 0;
  overflow: auto;
  flex: 1;
  font-size: 12px;
}
`.trim();
