/**
 * server/core/llm/protocol.ts
 *
 * Protocol adapter contract and registry.
 *
 * Each wire protocol (OpenAI-compatible, Anthropic native, ...) is implemented
 * as a `ProtocolAdapter`. `invoke()` looks up the right adapter based on
 * `LLMCallOptions.protocol` and delegates the HTTP work to it.
 *
 * Adapters self-register via side-effect imports in `register.ts`. Adding a
 * new protocol means writing one adapter file and adding one line to
 * `register.ts` — no other file in the system changes.
 *
 * The adapter contract is intentionally tiny: take normalized
 * `LLMCallOptions` in, return a normalized `LLMTurnResult`. The
 * adapter owns:
 *   - HTTP request shape (URL, headers, body, auth)
 *   - Streaming transport (SSE parsing, abort handling)
 *   - Response parsing (text, native tool calls, thinking, usage)
 *
 * The adapter does NOT own:
 *   - XML tool-call mode (handled in `invoke.ts` around the call)
 *   - Retries / rate-limit handling (handled in the pipeline layer)
 *   - DB or context concerns (handled in SessionContext)
 */

import type { LLMCallOptions, LLMTurnResult, Protocol } from "./types.js";

export interface ProtocolAdapter {
  readonly protocol: Protocol;
  /**
   * Make a single LLM call. Throws on transport or HTTP errors; the
   * pipeline layer decides whether to retry.
   *
   * If `options.onPartial` is provided, the adapter MUST stream and emit
   * partial events as they arrive. The returned `LLMTurnResult` still
   * contains the fully-assembled final output.
   */
  call(options: LLMCallOptions): Promise<LLMTurnResult>;
}

const registry = new Map<Protocol, ProtocolAdapter>();

export function registerAdapter(adapter: ProtocolAdapter): void {
  registry.set(adapter.protocol, adapter);
}

export function getAdapter(protocol: Protocol): ProtocolAdapter {
  const adapter = registry.get(protocol);
  if (!adapter) {
    const known = [...registry.keys()].join(", ") || "none";
    throw new Error(
      `No adapter registered for protocol "${protocol}". Registered: [${known}].`,
    );
  }
  return adapter;
}

export function listProtocols(): Protocol[] {
  return [...registry.keys()];
}
