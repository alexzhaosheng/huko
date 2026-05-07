/**
 * server/core/llm/providers/openrouter.ts
 *
 * OpenRouter provider preset.
 *
 * OpenRouter is an aggregator: one HTTP endpoint, ~hundreds of models,
 * pay-as-you-go. It speaks the OpenAI Chat Completions protocol with
 * a few conventions of its own:
 *
 *   - Base URL:  https://openrouter.ai/api/v1
 *   - Model IDs: vendor-prefixed, e.g. "anthropic/claude-opus-4-5",
 *                "openai/gpt-5", "google/gemini-2.5-pro".
 *   - Headers:   `HTTP-Referer` and `X-Title` are optional but
 *                recommended for app attribution and rate-limit tier.
 *
 * "Provider preset" is just a partial-options helper. The real
 * abstraction lives at the protocol layer; this is convenience sugar
 * so callers don't have to remember the base URL or header conventions.
 *
 * Usage:
 *
 *     import { invoke, withOpenRouter } from "@/core/llm";
 *
 *     const result = await invoke(withOpenRouter({
 *       apiKey: process.env.OPENROUTER_API_KEY!,
 *       model: "anthropic/claude-opus-4-5",
 *       messages: [{ role: "user", content: "hi" }],
 *       tools: [],
 *       toolCallMode: "native",
 *       onPartial: (e) => process.stdout.write(e.delta),
 *     }));
 */

import type { LLMCallOptions, Protocol } from "../types.js";

export type ProviderPreset = {
  /** Stable identifier (machine-readable). */
  id: string;
  /** Display name. */
  name: string;
  /** Wire protocol this provider speaks. */
  protocol: Protocol;
  /** Base URL for API calls. */
  baseUrl: string;
  /** Headers merged into every request by `withOpenRouter()`. */
  defaultHeaders?: Record<string, string>;
  /** Documentation pointer (not used at runtime). */
  docs?: string;
};

/**
 * The site / app identity sent to OpenRouter for attribution. Override
 * via env vars for dev / staging / prod environments without touching
 * code.
 */
const APP_REFERER = process.env["OPENROUTER_APP_URL"] ?? "https://huko.dev";
const APP_TITLE = process.env["OPENROUTER_APP_TITLE"] ?? "Huko";

export const openrouter: ProviderPreset = {
  id: "openrouter",
  name: "OpenRouter",
  protocol: "openai",
  baseUrl: "https://openrouter.ai/api/v1",
  defaultHeaders: {
    "HTTP-Referer": APP_REFERER,
    "X-Title": APP_TITLE,
  },
  docs: "https://openrouter.ai/docs",
};

/**
 * Build a fully-formed `LLMCallOptions` for an OpenRouter call.
 *
 * Caller supplies model + content; this fills in protocol, baseUrl, and
 * the default headers. Headers and extras can still be overridden.
 */
export function withOpenRouter(
  partial: Omit<LLMCallOptions, "protocol" | "baseUrl"> & {
    /** Override / extend OpenRouter's default headers. */
    headers?: Record<string, string>;
  },
): LLMCallOptions {
  return {
    ...partial,
    protocol: openrouter.protocol,
    baseUrl: openrouter.baseUrl,
    headers: { ...openrouter.defaultHeaders, ...(partial.headers ?? {}) },
  };
}
