/**
 * server/config/infra-config-types.ts
 *
 * Types for the layered infra config — providers, models, default
 * model. Replaces `InfraPersistence` (which used SQLite for what is
 * really declarative configuration). Lives next to the existing
 * config types so the whole "user-facing knobs" surface is in one
 * directory.
 *
 * Three layers, low-to-high precedence:
 *   1. Built-in    — shipped with huko, edited only by upgrading huko
 *   2. Global      — `~/.huko/providers.json`, edited by user
 *   3. Project     — `<cwd>/.huko/providers.json`, can be checked into git
 *
 * Merge rules:
 *   - Providers merge by `name`.
 *   - Models merge by `(providerName, modelId)`.
 *   - `defaultModel` is a single value; project wins, then global,
 *     then built-in.
 *   - Each layer can list `disabledProviders` / `disabledModels` to
 *     veto entries from any lower layer (built-in or global). Local
 *     entries in the same layer ignore the disable list.
 */

import type { Protocol, ThinkLevel, ToolCallMode } from "../../shared/llm-protocol.js";

// ─── On-disk shapes ─────────────────────────────────────────────────────────

/** Provider definition as it appears in a JSON file or built-in array. */
export type ProviderConfig = {
  /** Stable, lowercase identifier; primary key for merging. */
  name: string;
  protocol: Protocol;
  baseUrl: string;
  /**
   * Logical key reference (NOT the secret). Resolved at runtime via
   * `server/security/keys.ts` against `<cwd>/.huko/keys.json`, env,
   * and `<cwd>/.env`.
   */
  apiKeyRef: string;
  /**
   * Headers attached to every request (e.g. OpenRouter's HTTP-Referer).
   * Optional; null/absent both mean "no extra headers".
   */
  defaultHeaders?: Record<string, string> | null;
};

/** Model definition. References its provider by NAME (not numeric id). */
export type ModelConfig = {
  providerName: string;
  /** Wire-level model identifier the provider expects. */
  modelId: string;
  /** Human label, e.g. "Claude Sonnet 4.6". */
  displayName: string;
  defaultThinkLevel?: ThinkLevel;
  defaultToolCallMode?: ToolCallMode;
  /** Override estimateContextWindow() for this model. */
  contextWindow?: number;
};

/** Pointer to a model by composite key. */
export type ProviderModelRef = {
  providerName: string;
  modelId: string;
};

/**
 * Shape of `providers.json` (one file format used by both global and
 * project layers). All fields optional — an empty `{}` is a valid file.
 *
 * `currentProvider` and `currentModel` are independent pointers — each
 * is layered separately (project > global > builtin). The runtime
 * validates that the resulting pair `(currentProvider, currentModel)`
 * points to a model that exists in the merged definitions.
 */
export type InfraConfigFile = {
  providers?: ProviderConfig[];
  models?: ModelConfig[];
  /** Provider name. Layered project > global > builtin. */
  currentProvider?: string;
  /** Model id (paired with currentProvider). Layered project > global > builtin. */
  currentModel?: string;
  /** Names of providers (from any lower layer) to drop from the merged view. */
  disabledProviders?: string[];
  /** (providerName, modelId) pairs to drop from the merged view. */
  disabledModels?: ProviderModelRef[];
};

// ─── Resolved (post-merge) shapes ───────────────────────────────────────────

/** Where a merged entry came from. Surfaced in `huko provider list` etc. */
export type ConfigSource = "builtin" | "global" | "project";

/** A provider entry in the merged view, with its source. */
export type ResolvedProvider = ProviderConfig & {
  source: ConfigSource;
};

/**
 * A model entry in the merged view, with its source AND a resolved
 * pointer to its provider. Consumers (orchestrator, CLI) hold these
 * directly — no second lookup needed.
 */
export type ResolvedModel = ModelConfig & {
  source: ConfigSource;
  /** The provider the orchestrator opens an HTTP client against. */
  provider: ResolvedProvider;
};

/**
 * The fully-merged infra view. Sync to construct, immutable.
 *
 * `currentProvider` / `currentModel` are the resolved entities the
 * pointers indicate. They're null when the pointer is unset across all
 * layers, OR when the pointer is set but doesn't match a known
 * provider / model (orphan).
 *
 * `currentProviderSource` / `currentModelSource` say which LAYER the
 * pointer came from (project > global > builtin), independent of where
 * the entity is defined. The source can differ from
 * `currentProvider.source`: e.g. project sets `currentProvider:
 * "anthropic"` but the anthropic provider definition is a built-in.
 */
export type InfraConfig = {
  providers: ResolvedProvider[];
  models: ResolvedModel[];
  currentProvider: ResolvedProvider | null;
  currentProviderSource: ConfigSource | null;
  currentModel: ResolvedModel | null;
  currentModelSource: ConfigSource | null;
};
