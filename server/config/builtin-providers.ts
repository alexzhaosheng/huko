/**
 * server/config/builtin-providers.ts
 *
 * Built-in provider / model definitions shipped with huko. The "you
 * just installed huko, set one API key, type huko" set.
 *
 * Designed to overlap zero with user state — these are inert data
 * imported by `infra-config.ts` and merged into the runtime view.
 * The user can override any entry by listing it in `~/.huko/providers.json`
 * (global) or `<cwd>/.huko/providers.json` (project), or veto entries
 * via `disabledProviders` / `disabledModels`.
 *
 * Curation principle:
 *   - Include endpoints + a small "starter pack" of well-known model
 *     IDs per provider. The user adds more via `huko model add`.
 *   - A wrong default is worse than no default. Omit anything we're
 *     not confident is stable.
 *
 * Last verified: May 2026. Model IDs are snapshot-pinned where the
 * provider's API uses pinned format (e.g. Anthropic claude-4.6+
 * dateless = pinned snapshot, not floating alias).
 *
 * To extend: edit the arrays below and ship a new huko version. Users
 * can add to or veto from this set without modifying huko itself.
 */

import type {
  ModelConfig,
  ProviderConfig,
} from "./infra-config-types.js";

// ─── Providers ──────────────────────────────────────────────────────────────

export const BUILTIN_PROVIDERS: ProviderConfig[] = [
  {
    name: "anthropic",
    protocol: "anthropic",
    baseUrl: "https://api.anthropic.com",
    apiKeyRef: "anthropic",
  },
  {
    name: "openai",
    protocol: "openai",
    baseUrl: "https://api.openai.com/v1",
    apiKeyRef: "openai",
  },
  {
    name: "openrouter",
    protocol: "openai",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKeyRef: "openrouter",
    defaultHeaders: { "HTTP-Referer": "https://github.com/huko" },
  },
  {
    name: "deepseek",
    protocol: "openai",
    baseUrl: "https://api.deepseek.com",
    apiKeyRef: "deepseek",
  },
  {
    name: "moonshot",
    protocol: "openai",
    baseUrl: "https://api.moonshot.cn/v1",
    apiKeyRef: "moonshot",
  },
  {
    name: "groq",
    protocol: "openai",
    baseUrl: "https://api.groq.com/openai/v1",
    apiKeyRef: "groq",
  },
  {
    // Google's OpenAI-compatible endpoint. Native Gemini protocol works
    // too but isn't supported by huko (see core/llm/types Protocol).
    name: "google",
    protocol: "openai",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    apiKeyRef: "google",
  },
  {
    // Alibaba DashScope OpenAI-compatible. International endpoint by
    // default; mainland users can override baseUrl in their global
    // providers.json to dashscope.aliyuncs.com.
    name: "qwen",
    protocol: "openai",
    baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    apiKeyRef: "qwen",
  },
  {
    // Zhipu AI (智谱) OpenAI-compatible. Model IDs use the glm-*
    // family; endpoint documented at docs.bigmodel.cn.
    name: "zhipu",
    protocol: "openai",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    apiKeyRef: "zhipu",
  },
  {
    // MiniMax (稀宇) OpenAI-compatible. Model IDs use the MiniMax-M2.*
    // family; endpoint documented at platform.minimax.io/docs.
    name: "minimax",
    protocol: "openai",
    baseUrl: "https://api.minimax.io/v1",
    apiKeyRef: "minimax",
  },
  {
    name: "ollama",
    protocol: "openai",
    baseUrl: "http://localhost:11434/v1",
    apiKeyRef: "ollama",
  },
];

// ─── Models ─────────────────────────────────────────────────────────────────

export const BUILTIN_MODELS: ModelConfig[] = [
  // ── Anthropic — direct ──
  {
    providerName: "anthropic",
    modelId: "claude-opus-4-7",
    displayName: "Claude Opus 4.7",
  },
  {
    providerName: "anthropic",
    modelId: "claude-opus-4-6",
    displayName: "Claude Opus 4.6",
  },
  {
    providerName: "anthropic",
    modelId: "claude-sonnet-4-6",
    displayName: "Claude Sonnet 4.6",
  },
  {
    providerName: "anthropic",
    modelId: "claude-haiku-4-5",
    displayName: "Claude Haiku 4.5",
  },

  // ── OpenAI — direct ──
  {
    providerName: "openai",
    modelId: "gpt-5.5",
    displayName: "GPT-5.5",
  },
  {
    providerName: "openai",
    modelId: "gpt-5.5-pro",
    displayName: "GPT-5.5 Pro",
  },
  {
    providerName: "openai",
    modelId: "gpt-5.4-mini",
    displayName: "GPT-5.4 Mini",
  },
  {
    providerName: "openai",
    modelId: "gpt-5.4-nano",
    displayName: "GPT-5.4 Nano",
  },

  // ── OpenRouter — popular slugs (single key, many models) ──
  {
    providerName: "openrouter",
    modelId: "anthropic/claude-opus-4.7",
    displayName: "Claude Opus 4.7 (OR)",
  },
  {
    providerName: "openrouter",
    modelId: "anthropic/claude-sonnet-4.6",
    displayName: "Claude Sonnet 4.6 (OR)",
  },
  {
    providerName: "openrouter",
    modelId: "openai/gpt-5.5",
    displayName: "GPT-5.5 (OR)",
  },
  {
    providerName: "openrouter",
    modelId: "deepseek/deepseek-v4-pro",
    displayName: "DeepSeek V4 Pro (OR)",
  },
  {
    providerName: "openrouter",
    modelId: "moonshotai/kimi-k2.6",
    displayName: "Kimi K2.6 (OR)",
  },
  {
    providerName: "openrouter",
    modelId: "google/gemini-3.1-pro",
    displayName: "Gemini 3.1 Pro (OR)",
  },

  // ── DeepSeek — direct (V4 series; chat/reasoner aliases deprecated 2026-07-24) ──
  {
    providerName: "deepseek",
    modelId: "deepseek-v4-pro",
    displayName: "DeepSeek V4 Pro",
  },
  {
    providerName: "deepseek",
    modelId: "deepseek-v4-flash",
    displayName: "DeepSeek V4 Flash",
  },

  // ── Moonshot / Kimi — direct (k2 deprecated 2026-05-25) ──
  {
    providerName: "moonshot",
    modelId: "kimi-k2.6",
    displayName: "Kimi K2.6",
  },
  {
    providerName: "moonshot",
    modelId: "kimi-k2.5",
    displayName: "Kimi K2.5",
  },

  // ── Groq — direct (fast inference, OpenAI-compatible) ──
  {
    providerName: "groq",
    modelId: "llama-3.3-70b-versatile",
    displayName: "Llama 3.3 70B (Groq)",
  },
  {
    providerName: "groq",
    modelId: "qwen/qwen3-32b",
    displayName: "Qwen3 32B (Groq)",
  },
  {
    providerName: "groq",
    modelId: "openai/gpt-oss-120b",
    displayName: "GPT-OSS 120B (Groq)",
  },

  // ── Google Gemini — direct via OpenAI-compatible endpoint ──
  {
    providerName: "google",
    modelId: "gemini-3.1-pro",
    displayName: "Gemini 3.1 Pro",
  },
  {
    providerName: "google",
    modelId: "gemini-2.5-pro",
    displayName: "Gemini 2.5 Pro",
  },
  {
    providerName: "google",
    modelId: "gemini-2.5-flash",
    displayName: "Gemini 2.5 Flash",
  },

  // ── Alibaba Qwen — direct via DashScope OpenAI-compatible ──
  {
    providerName: "qwen",
    modelId: "qwen3-max",
    displayName: "Qwen3 Max",
  },
  {
    providerName: "qwen",
    modelId: "qwen3.5-plus",
    displayName: "Qwen 3.5 Plus",
  },
  {
    providerName: "qwen",
    modelId: "qwen3.5-flash",
    displayName: "Qwen 3.5 Flash",
  },
  {
    providerName: "qwen",
    modelId: "qwen3-coder-plus",
    displayName: "Qwen3 Coder Plus",
  },

  // ── Zhipu AI (智谱) — direct via OpenAI-compatible endpoint ──
  {
    providerName: "zhipu",
    modelId: "glm-5.1",
    displayName: "GLM 5.1",
  },
  {
    providerName: "zhipu",
    modelId: "glm-5",
    displayName: "GLM 5",
  },
  {
    providerName: "zhipu",
    modelId: "glm-4.7",
    displayName: "GLM 4.7",
  },
  {
    providerName: "zhipu",
    modelId: "glm-4.6",
    displayName: "GLM 4.6",
  },

  // ── MiniMax (稀宇) — direct via OpenAI-compatible endpoint ──
  {
    providerName: "minimax",
    modelId: "MiniMax-M2.7",
    displayName: "MiniMax M2.7",
  },
  {
    providerName: "minimax",
    modelId: "MiniMax-M2.5",
    displayName: "MiniMax M2.5",
  },
  {
    providerName: "minimax",
    modelId: "MiniMax-M2.1",
    displayName: "MiniMax M2.1",
  },
  {
    providerName: "minimax",
    modelId: "MiniMax-M2",
    displayName: "MiniMax M2",
  },

  // ── Ollama — local ──
  {
    providerName: "ollama",
    modelId: "llama3.3",
    displayName: "Llama 3.3 (local)",
  },
  {
    providerName: "ollama",
    modelId: "qwen3",
    displayName: "Qwen 3 (local)",
  },
  {
    providerName: "ollama",
    modelId: "deepseek-r1",
    displayName: "DeepSeek R1 (local)",
  },
];

// ─── No implicit current pointer ────────────────────────────────────────────
//
// We deliberately do NOT ship a built-in `currentProvider` / `currentModel`.
// The catalog above is "what huko knows about", not "what to use". A fresh
// install has no preselected vendor — the user picks via `huko setup` (the
// interactive wizard) or `huko provider current` + `huko model current`.
// Picking a default for the user would mean shipping a wrong default for
// most of them, since "which LLM" is a key/billing/policy decision huko
// has no way to know.
//
// The `run` command (server/cli/commands/run.ts) surfaces a clear "set up
// first" message when these pointers are null.
