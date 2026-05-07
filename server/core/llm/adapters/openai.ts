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
 * Streaming
 * ─────────
 * If `options.onPartial` is set we use SSE. Content and reasoning deltas
 * are pushed through the callback as they arrive; tool-call argument
 * deltas are accumulated internally and surfaced in one piece on the
 * final result. The promise resolves only after `[DONE]` (or stream end).
 *
 * Reasoning
 * ─────────
 * The field name varies by upstream model:
 *   - DeepSeek-style: `reasoning_content`
 *   - OpenRouter normalized: `reasoning`
 * Both are accepted and unified into `LLMTurnResult.thinking`.
 *
 * Reasoning effort is sent as `reasoning_effort` (OpenAI o-series, also
 * understood by OpenRouter as a passthrough).
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

    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      ...(options.signal ? { signal: options.signal } : {}),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new LLMHttpError(res.status, res.statusText, text);
    }

    return stream ? readStream(res, options) : readNonStream(res);
  },
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

  // Provider-specific extras win over defaults — escape hatch for
  // non-portable knobs. Applied last so callers can override anything.
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
      // OpenAI accepts `content: null` when only tool_calls are present.
      content: m.content === "" && m.toolCalls && m.toolCalls.length > 0 ? null : m.content,
    };
    if (m.toolCalls && m.toolCalls.length > 0) {
      out["tool_calls"] = m.toolCalls.map((c) => ({
        id: c.id,
        type: "function",
        function: { name: c.name, arguments: JSON.stringify(c.arguments) },
      }));
    }
    return out;
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

async function readNonStream(res: Response): Promise<LLMTurnResult> {
  const json = (await res.json()) as ChatCompletionResponse;
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

async function readStream(res: Response, options: LLMCallOptions): Promise<LLMTurnResult> {
  if (!res.body) throw new Error("Streaming response has no body");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();

  let content = "";
  let thinking = "";
  /** Tool calls accumulate by index — args arrive as JSON-string deltas. */
  const tcAcc = new Map<number, { id?: string; name?: string; args: string }>();
  let usage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

  let buffer = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // SSE messages are separated by blank lines; within a message, lines
      // start with `data: `. We process line-by-line for simplicity — most
      // OpenAI-compatible servers emit one `data:` line per event.
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const rawLine = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        const line = rawLine.replace(/\r$/, "").trim();

        if (!line || line.startsWith(":")) continue; // keep-alive comments
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
    // Best-effort release. Ignore errors — the body may already be closed.
    try {
      reader.releaseLock();
    } catch {
      /* noop */
    }
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
  return {
    promptTokens: u?.prompt_tokens ?? 0,
    completionTokens: u?.completion_tokens ?? 0,
    totalTokens: u?.total_tokens ?? 0,
  };
}

function joinUrl(base: string, path: string): string {
  return base.replace(/\/+$/, "") + "/" + path.replace(/^\/+/, "");
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

// ─── Wire types (minimal subset of the OpenAI API) ───────────────────────────

interface ChatCompletionUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
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
