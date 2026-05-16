/**
 * server/core/llm/model-context-window.ts
 *
 * Heuristic estimator: model id string → context window size in tokens.
 *
 * Why this lives here: until we add a `context_window` column to the
 * `models` DB table (deferred — would need a migration + admin UI to
 * edit), the model id pattern is the only signal we have. Modern
 * providers don't expose context window via their API surface in a
 * uniform way either, so a static table is the pragmatic choice.
 *
 * The table is intentionally LOSSY — we group by family, not exact
 * version. Compaction works on a percentage of the window so being a
 * little off is fine. Better to over-compact (early trim) than to
 * under-compact (400 from the API).
 *
 * Override path: a future `models.contextWindow` field on
 * `ResolvedModelConfig` takes precedence. This estimator is the
 * fallback.
 */

/** Conservative default if we can't recognise the model id pattern. */
const DEFAULT_CONTEXT_WINDOW = 32_000;

/**
 * Map model-id substring (case-insensitive) → context window in tokens.
 *
 * Order matters — first matching substring wins. Put more specific
 * patterns BEFORE generic ones (e.g. "claude-3-haiku" before "claude").
 */
const HEURISTIC_TABLE: ReadonlyArray<readonly [string, number]> = [
  // ── Anthropic ─────────────────────────────────────────────────────────
  ["claude-opus-4", 200_000],
  ["claude-sonnet-4", 200_000],
  ["claude-haiku-4", 200_000],
  ["claude-3-5-sonnet", 200_000],
  ["claude-3-5-haiku", 200_000],
  ["claude-3.5-sonnet", 200_000],
  ["claude-3.5-haiku", 200_000],
  ["claude-3-opus", 200_000],
  ["claude-3-sonnet", 200_000],
  ["claude-3-haiku", 200_000],
  ["claude-2.1", 200_000],
  ["claude-2", 100_000],
  ["claude-instant", 100_000],
  ["claude", 200_000], // generic claude/* fallback

  // ── OpenAI ───────────────────────────────────────────────────────────
  ["gpt-5", 400_000],
  ["gpt-4.1", 1_000_000],
  ["gpt-4o-mini", 128_000],
  ["gpt-4o", 128_000],
  ["gpt-4-turbo", 128_000],
  ["gpt-4-32k", 32_000],
  ["gpt-4", 8_000],
  ["gpt-3.5-turbo-16k", 16_000],
  ["gpt-3.5-turbo", 16_000],
  ["o1-mini", 128_000],
  ["o1", 200_000],
  ["o3-mini", 200_000],
  ["o3", 200_000],

  // ── Google ───────────────────────────────────────────────────────────
  ["gemini-2.5-pro", 2_000_000],
  ["gemini-2.0-pro", 2_000_000],
  ["gemini-2.0-flash", 1_000_000],
  ["gemini-1.5-pro", 2_000_000],
  ["gemini-1.5-flash", 1_000_000],
  ["gemini-pro", 32_000],
  ["gemini", 32_000],

  // ── xAI ──────────────────────────────────────────────────────────────
  ["grok-2", 128_000],
  ["grok", 128_000],

  // ── Meta / Mistral / Open source ─────────────────────────────────────
  ["llama-3.3-70b", 128_000],
  ["llama-3.2", 128_000],
  ["llama-3.1", 128_000],
  ["llama-3", 8_000],
  ["llama-2", 4_000],
  ["llama", 8_000],
  ["mistral-large", 128_000],
  ["mistral", 32_000],
  ["mixtral", 32_000],
  ["deepseek-r1", 64_000],
  ["deepseek-v3", 64_000],
  ["deepseek-coder", 16_000],
  // V4 family — conservative 256K default. V4 Pro / Flash advertise
  // larger windows, but the effective limit varies by deployment /
  // gateway and 1M was rarely the right number in practice (compaction
  // never fired on bloated sessions). 256K is a safer floor that still
  // lets compaction trigger late enough to avoid premature trimming on
  // normal use. Pin a precise value per-model with
  // `huko model update <ref> --context-window=N`.
  ["deepseek-v4-pro", 256_000],
  ["deepseek-v4-flash", 256_000],
  ["deepseek", 64_000],
  ["qwen-2.5", 128_000],
  ["qwen-2", 32_000],
  ["qwen", 32_000],

  // ── Zhipu GLM ────────────────────────────────────────────────────────
  // GLM-5.1 / GLM-5: 200K context window (docs.bigmodel.cn)
  ["glm-5", 200_000],
  // GLM-4.6 / GLM-4.7: 200K context window (docs.bigmodel.cn)
  ["glm-4", 200_000],
  ["glm", 128_000], // generic glm/* fallback

  // ── MiniMax ───────────────────────────────────────────────────────────
  // MiniMax-M2 family: 204,800 context window (platform.minimax.io)
  ["minimax-m2", 204_800],
  ["minimax", 204_800], // generic minimax/* fallback

  // ── Moonshot / Kimi ───────────────────────────────────────────────────
  // Kimi K2.6: 256K context; K2.5: 128K. Use 256K for the K2 family.
  ["kimi-k2", 256_000],
  ["kimi", 128_000], // generic kimi/* fallback
];

/**
 * Estimate a model's context window from its id string.
 *
 * Case-insensitive substring match against `HEURISTIC_TABLE`. Returns
 * the first match's window or `DEFAULT_CONTEXT_WINDOW` (32k) if none.
 *
 * Examples:
 *   estimateContextWindow("anthropic/claude-3.5-haiku")  → 200_000
 *   estimateContextWindow("openai/gpt-4o")               → 128_000
 *   estimateContextWindow("custom/unknown-model")        →  32_000
 */
export function estimateContextWindow(modelId: string): number {
  const lower = modelId.toLowerCase();
  for (const [pattern, window] of HEURISTIC_TABLE) {
    if (lower.includes(pattern)) return window;
  }
  return DEFAULT_CONTEXT_WINDOW;
}

/** Exposed for tests / diagnostics. */
export const CONTEXT_WINDOW_DEFAULT = DEFAULT_CONTEXT_WINDOW;
