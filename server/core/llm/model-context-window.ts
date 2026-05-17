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
  // 2026-Q2: Claude Opus 4.6 / 4.7 and Sonnet 4.6 ship a 1M-token context
  // window at standard pricing. Sonnet 4.5 and the entire Haiku 4 line
  // stay at 200K. Older 3.x / 2.x preserved verbatim.
  ["claude-opus-4-7", 1_000_000],
  ["claude-opus-4-6", 1_000_000],
  ["claude-sonnet-4-6", 1_000_000],
  ["claude-opus-4", 200_000],       // 4.0 / 4.1 — pre-1M era
  ["claude-sonnet-4", 200_000],     // 4.0 .. 4.5
  ["claude-haiku-4", 200_000],      // entire 4.x Haiku family
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
  // GPT-5.4 (Mar 2026) and GPT-5.5 (Apr 2026) jumped to 1M; earlier 5.x
  // versions stepped through 400K → 512K → 768K. 4.1 already had 1M.
  ["gpt-5.5", 1_000_000],
  ["gpt-5.4", 1_000_000],
  ["gpt-5.2", 768_000],
  ["gpt-5.1", 512_000],
  ["gpt-5", 400_000],
  ["gpt-4.1", 1_000_000],
  ["gpt-4o-mini", 128_000],
  ["gpt-4o", 128_000],
  ["gpt-4-turbo", 128_000],
  ["gpt-4-32k", 32_000],
  ["gpt-4", 8_000],
  ["gpt-3.5-turbo-16k", 16_000],
  ["gpt-3.5-turbo", 16_000],
  ["o4-mini", 200_000],
  ["o4", 200_000],
  ["o3-mini", 200_000],
  ["o3", 200_000],
  ["o1-mini", 128_000],
  ["o1", 200_000],

  // ── Google ───────────────────────────────────────────────────────────
  // Gemini 3 Pro/Flash launched at 1M (some Pro tiers extend to 2M).
  // 2.5 Pro stays at 2M; 2.0 Flash at 1M.
  ["gemini-3-pro", 1_000_000],
  ["gemini-3-flash", 1_000_000],
  ["gemini-2.5-pro", 2_000_000],
  ["gemini-2.0-pro", 2_000_000],
  ["gemini-2.0-flash", 1_000_000],
  ["gemini-1.5-pro", 2_000_000],
  ["gemini-1.5-flash", 1_000_000],
  ["gemini-pro", 32_000],
  ["gemini", 32_000],

  // ── xAI ──────────────────────────────────────────────────────────────
  // Grok 4.20 / 4-fast: 2M (largest currently available among frontier
  // hosted models). Grok 4.3 (May 2026): 1M. Original Grok 4: 256K.
  ["grok-4-fast", 2_000_000],
  ["grok-4.20", 2_000_000],
  ["grok-4-20", 2_000_000],
  ["grok-4.3", 1_000_000],
  ["grok-4-3", 1_000_000],
  ["grok-4", 256_000],
  ["grok-2", 128_000],
  ["grok", 128_000],

  // ── Meta / Mistral / Open source ─────────────────────────────────────
  // Llama 4 Scout advertises 10M tokens (theoretical, hardware-bounded);
  // Maverick lands at 1M. Pin a smaller per-model number with
  // `huko model update <ref> --context-window=N` for self-hosted setups
  // where GPU memory is the real ceiling.
  ["llama-4-scout", 10_000_000],
  ["llama-4-maverick", 1_000_000],
  ["llama-4", 1_000_000],
  ["llama-3.3", 128_000],
  ["llama-3.2", 128_000],
  ["llama-3.1", 128_000],
  ["llama-3", 8_000],
  ["llama-2", 4_000],
  ["llama", 8_000],
  ["mistral-large-3", 262_144],   // 2026 MoE; the only Mistral past Large 2
  ["mistral-large", 128_000],
  ["mistral", 32_000],
  ["mixtral", 32_000],
  // DeepSeek V4 (Apr 2026): 1M default context for both Pro and Flash.
  // Earlier V3 / R1 line stays at 64K. Pin a more conservative value
  // with `--context-window=N` if your gateway truncates below 1M.
  ["deepseek-v4-pro", 1_000_000],
  ["deepseek-v4-flash", 1_000_000],
  ["deepseek-v4", 1_000_000],
  ["deepseek-r1", 64_000],
  ["deepseek-v3", 64_000],
  ["deepseek-coder", 16_000],
  ["deepseek", 64_000],
  // Alibaba Qwen 3.5+ flagship models ship 1M tokens; mid-size dense
  // models (e.g. Qwen3.6-27B) cap at 256K natively but advertise 1M
  // extendable via YARN / RoPE scaling.
  ["qwen3.6-plus", 1_000_000],
  ["qwen3.5-plus", 1_000_000],
  ["qwen3.6", 262_144],
  ["qwen3.5", 262_144],
  ["qwen-2.5", 128_000],
  ["qwen-2", 32_000],
  ["qwen", 32_000],

  // ── Zhipu GLM ────────────────────────────────────────────────────────
  // GLM-5 (Feb 2026) and GLM-4.6 both 200K. (docs.bigmodel.cn / z.ai docs)
  ["glm-5", 200_000],
  ["glm-4", 200_000],
  ["glm", 128_000], // generic glm/* fallback

  // ── MiniMax ───────────────────────────────────────────────────────────
  // MiniMax M2 / M2.5 / M2.7: 204,800 context window (platform.minimax.io)
  ["minimax-m2", 204_800],
  ["minimax", 204_800], // generic minimax/* fallback

  // ── Moonshot / Kimi ───────────────────────────────────────────────────
  // Kimi K2.5 and K2.6 both ship 256K (262,144 exact).
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
