/**
 * server/core/llm/adapters/openai.ts
 *
 * OpenAI-compatible Chat Completions adapter.
 *
 * Speaks the de-facto standard: POST {baseUrl}/chat/completions, JSON in,
 * JSON or SSE out. Works with OpenAI proper, OpenRouter, Azure OpenAI,
 * DeepSeek, Together, Groq, vLLM, Ollama, and most "we speak OpenAI"
 * providers.
 *
 * Strips SYSTEM_PROMPT_CACHE_BOUNDARY from system messages — OpenAI's
 * automatic prefix cache already benefits from the volatile current-date
 * line being at the very end of the system prompt; the boundary marker
 * exists for a future native Anthropic adapter that splits the system
 * text into cached + uncached blocks at this seam.
 */

import type { ProtocolAdapter } from "../protocol.js";
import type {
  LLMCallOptions,
  LLMMessage,
  LLMTurnResult,
  Tool,
  ToolCall,
  TokenUsage,
} from "../types.js";
import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "../../../services/build-system-prompt.js";
import { getRawDebugLog, nextCallId, type RawDebugLog } from "../raw-debug-log.js";

export const openaiAdapter: ProtocolAdapter = {
  protocol: "openai",
  async call(options: LLMCallOptions): Promise<LLMTurnResult> {
    const stream = !!options.onPartial;
    const url = joinUrl(options.baseUrl, "/chat/completions");
    const body = buildBody(options, stream);

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${options.apiKey}`,
      ...(options.headers ?? {}),
    };

    // Raw-debug capture: getRawDebugLog returns a no-op when
    // HUKO_DEBUG_RAW_LLM is unset, so zero overhead in the normal case.
    const log = getRawDebugLog();
    const callId = nextCallId();
    const startMs = Date.now();
    log.logRequest({ callId, url, method: "POST", headers, body });

    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch (err) {
      log.logResponse({
        callId,
        status: 0,
        statusText: "fetch threw",
        durationMs: Date.now() - startMs,
        headers: {},
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      log.logResponse({
        callId,
        status: res.status,
        statusText: res.statusText,
        durationMs: Date.now() - startMs,
        headers: extractHeaders(res.headers),
        body: tryParseJson(text),
        error: text,
      });
      throw new LLMHttpError(res.status, res.statusText, text);
    }

    const debugCtx: DebugCtx = { log, callId, startMs };
    return stream
      ? readStream(res, options, debugCtx)
      : readNonStream(res, debugCtx);
  },
};

type DebugCtx = {
  log: RawDebugLog;
  callId: string;
  startMs: number;
};

// ─── Request body ────────────────────────────────────────────────────────────

function buildBody(options: LLMCallOptions, stream: boolean): Record<string, unknown> {
  const messages = options.messages.map(toApiMessage);
  const tools = options.toolCallMode === "native" ? formatTools(options.tools) : [];

  const body: Record<string, unknown> = {
    model: options.model,
    messages,
    stream,
    ...(stream ? { stream_options: { include_usage: true } } : {}),
    ...(tools.length > 0 ? { tools, tool_choice: "auto" } : {}),
  };

  if (options.thinkLevel && options.thinkLevel !== "off") {
    body["reasoning_effort"] = options.thinkLevel;
  }

  if (options.extras) {
    for (const [k, v] of Object.entries(options.extras)) body[k] = v;
  }

  return body;
}

function toApiMessage(m: LLMMessage): Record<string, unknown> {
  if (m.role === "tool") {
    return {
      role: "tool",
      tool_call_id: m.toolCallId ?? "",
      content: m.content,
    };
  }
  if (m.role === "assistant") {
    const out: Record<string, unknown> = {
      role: "assistant",
      content: m.content === "" && m.toolCalls && m.toolCalls.length > 0 ? null : m.content,
    };
    if (m.toolCalls && m.toolCalls.length > 0) {
      out["tool_calls"] = m.toolCalls.map((c) => ({
        id: c.id,
        type: "function",
        function: { name: c.name, arguments: JSON.stringify(c.arguments) },
      }));
    }
    // Echo reasoning back so providers that require it (DeepSeek's
    // thinking mode rejects the request with "reasoning_content must
    // be passed back to the API" otherwise) stay happy. Providers that
    // don't recognise the field ignore it. The value comes from the
    // matching response's `reasoning_content` / `reasoning`, captured
    // into LLMMessage.thinking by readNonStream / readStream below.
    if (m.thinking) {
      out["reasoning_content"] = m.thinking;
    }
    return out;
  }
  if (m.role === "system") {
    return {
      role: "system",
      content: m.content.split(SYSTEM_PROMPT_CACHE_BOUNDARY).join(""),
    };
  }
  return { role: m.role, content: m.content };
}

function formatTools(tools: Tool[]): Array<Record<string, unknown>> {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

// ─── Non-streaming response ──────────────────────────────────────────────────

async function readNonStream(res: Response, dbg: DebugCtx): Promise<LLMTurnResult> {
  // Read as text first so the raw bytes survive into the debug log even
  // if JSON parsing later fails. (`res.json()` would consume the body
  // before we could capture it.)
  const text = await res.text();
  dbg.log.logResponse({
    callId: dbg.callId,
    status: res.status,
    statusText: res.statusText,
    durationMs: Date.now() - dbg.startMs,
    headers: extractHeaders(res.headers),
    body: tryParseJson(text),
  });

  const json = JSON.parse(text) as ChatCompletionResponse;
  const msg = json.choices?.[0]?.message;

  const toolCalls: ToolCall[] = (msg?.tool_calls ?? []).map((c) => ({
    id: c.id,
    name: c.function.name,
    arguments: parseArgs(c.function.arguments),
  }));

  const reasoning = msg?.reasoning_content ?? msg?.reasoning;

  return {
    content: msg?.content ?? "",
    toolCalls,
    ...(reasoning ? { thinking: reasoning } : {}),
    usage: normalizeUsage(json.usage),
  };
}

// ─── Streaming response (SSE) ────────────────────────────────────────────────

async function readStream(
  res: Response,
  options: LLMCallOptions,
  dbg: DebugCtx,
): Promise<LLMTurnResult> {
  if (!res.body) throw new Error("Streaming response has no body");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();

  let content = "";
  let thinking = "";
  const tcAcc = new Map<number, { id?: string; name?: string; args: string }>();
  let usage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

  let buffer = "";
  // Verbatim SSE text accumulator for the raw debug log. Decoded once
  // from the same chunk we feed into `buffer` to avoid double-decoding.
  let rawSSE = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      const chunkText = decoder.decode(value, { stream: true });
      rawSSE += chunkText;
      buffer += chunkText;

      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const rawLine = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        const line = rawLine.replace(/\r$/, "").trim();

        if (!line || line.startsWith(":")) continue;
        if (!line.startsWith("data:")) continue;

        const payload = line.slice(5).trim();
        if (payload === "[DONE]") continue;

        let chunk: ChatCompletionStreamChunk;
        try {
          chunk = JSON.parse(payload);
        } catch {
          continue;
        }

        const delta = chunk.choices?.[0]?.delta;

        if (delta?.content) {
          content += delta.content;
          options.onPartial?.({ type: "content", delta: delta.content });
        }

        const reasoningDelta = delta?.reasoning_content ?? delta?.reasoning;
        if (reasoningDelta) {
          thinking += reasoningDelta;
          options.onPartial?.({ type: "thinking", delta: reasoningDelta });
        }

        for (const tc of delta?.tool_calls ?? []) {
          const idx = tc.index;
          const existing = tcAcc.get(idx) ?? { args: "" };
          if (tc.id) existing.id = tc.id;
          if (tc.function?.name) existing.name = tc.function.name;
          if (tc.function?.arguments) existing.args += tc.function.arguments;
          tcAcc.set(idx, existing);
        }

        if (chunk.usage) usage = normalizeUsage(chunk.usage);
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* noop */
    }
    // Log even on partial / aborted streams — what we got so far is
    // exactly what we want to see in the debug record.
    dbg.log.logResponse({
      callId: dbg.callId,
      status: res.status,
      statusText: res.statusText,
      durationMs: Date.now() - dbg.startMs,
      headers: extractHeaders(res.headers),
      rawSSE,
    });
  }

  const toolCalls: ToolCall[] = [];
  for (const [, v] of [...tcAcc.entries()].sort((a, b) => a[0] - b[0])) {
    if (!v.name) continue;
    toolCalls.push({
      id: v.id ?? `auto_${toolCalls.length}`,
      name: v.name,
      arguments: parseArgs(v.args || "{}"),
    });
  }

  return {
    content,
    toolCalls,
    ...(thinking ? { thinking } : {}),
    usage,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function parseArgs(raw: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function normalizeUsage(u: ChatCompletionUsage | undefined): TokenUsage {
  const usage: TokenUsage = {
    promptTokens: u?.prompt_tokens ?? 0,
    completionTokens: u?.completion_tokens ?? 0,
    totalTokens: u?.total_tokens ?? 0,
  };
  // Cache breakdown — extracted when the provider populates it.
  // OpenAI exposes `prompt_tokens_details.cached_tokens`; Anthropic-via-
  // OpenAI-shim and DeepSeek expose `cache_read_input_tokens` /
  // `cache_creation_input_tokens` at the top level. We accept both shapes.
  const cachedRead =
    u?.prompt_tokens_details?.cached_tokens ??
    u?.cache_read_input_tokens ??
    undefined;
  if (typeof cachedRead === "number" && cachedRead > 0) {
    usage.cachedTokens = cachedRead;
  }
  const cachedWrite = u?.cache_creation_input_tokens ?? undefined;
  if (typeof cachedWrite === "number" && cachedWrite > 0) {
    usage.cacheCreationTokens = cachedWrite;
  }
  return usage;
}

function joinUrl(base: string, path: string): string {
  return base.replace(/\/+$/, "") + "/" + path.replace(/^\/+/, "");
}

function extractHeaders(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((v, k) => {
    out[k] = v;
  });
  return out;
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// ─── Error ───────────────────────────────────────────────────────────────────

export class LLMHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly statusText: string,
    public readonly body: string,
  ) {
    super(`LLM HTTP ${status} ${statusText}: ${body.slice(0, 500)}`);
    this.name = "LLMHttpError";
  }
}

// ─── Wire types ─────────────────────────────────────────────────────────────

interface ChatCompletionUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  /** OpenAI shape: nested cached_tokens under prompt_tokens_details. */
  prompt_tokens_details?: {
    cached_tokens?: number;
  };
  /** Anthropic-style flat fields, surfaced by some compatible servers. */
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string;
      tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
      reasoning_content?: string;
      reasoning?: string;
    };
  }>;
  usage?: ChatCompletionUsage;
}

interface ChatCompletionStreamChunk {
  choices?: Array<{
    delta?: {
      content?: string;
      reasoning_content?: string;
      reasoning?: string;
      tool_calls?: Array<{
        index: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
  }>;
  usage?: ChatCompletionUsage;
}
