/**
 * server/config/types.ts
 *
 * The single typed schema for huko's configuration.
 *
 * Every field listed here is a tunable that an operator might want to
 * adjust without editing source. The corresponding hardcoded constants
 * in modules (task-loop, context-manage, web-fetch, etc.) read from
 * here at module-load time via `getConfig()`.
 *
 * Adding a tunable:
 *   1. Add the field here, in `HukoConfig` (with TS type + JSDoc).
 *   2. Add its default to `DEFAULT_CONFIG`.
 *   3. Replace the hardcoded constant at its consumer with
 *      `getConfig().<group>.<field>`.
 *
 * Removing a tunable:
 *   - Just delete the field. Existing config files with the field
 *     remain valid — the loader's deep-merge is forgiving on extras.
 *
 * Forward-compat note: any unknown keys in user-supplied config files
 * are PRESERVED (not stripped) so older huko versions reading newer
 * configs don't lose information; they're just unread by this version.
 */

// ─── Schema ──────────────────────────────────────────────────────────────────

export type HukoConfig = {
  /** Task loop budgets — defensive bounds against runaway tasks. */
  task: {
    /** Hard cap on LLM iterations per task. */
    maxIterations: number;
    /** Hard cap on tool executions per task. */
    maxToolCalls: number;
    /** Bounded retries when the LLM produces empty turns. */
    maxEmptyRetries: number;
  };

  /** Context window compaction. Ratios are fractions of model context window. */
  compaction: {
    /** Compaction triggers when approxTokens / contextWindow >= this. */
    thresholdRatio: number;
    /** Compaction trims context to roughly this fraction of contextWindow. */
    targetRatio: number;
    /** Approximate chars per token used for budget estimation. */
    charsPerToken: number;
  };

  /** Role / persona system. */
  role: {
    /** Default role name when `--role` is not passed. */
    default: string;
  };

  /** Built-in tool tunables. */
  tools: {
    webFetch: {
      /** Max body bytes accepted from a fetch (bytes). */
      maxBytes: number;
      /** Hard timeout per fetch (milliseconds). */
      timeoutMs: number;
    };
  };

  /** CLI defaults. */
  cli: {
    /** Default output format when `--format` is not passed. */
    format: "text" | "jsonl" | "json";
  };

  /** Daemon HTTP/WS server (only used when `huko start` is implemented). */
  daemon: {
    port: number;
    host: string;
  };
};

// ─── Built-in defaults ───────────────────────────────────────────────────────

/**
 * The fallback values used when no config file (or env) overrides a field.
 *
 * Keep these conservative — they ship to every user. Dramatic changes
 * here are a behavior change, not a config tweak.
 */
export const DEFAULT_CONFIG: HukoConfig = {
  task: {
    maxIterations: 200,
    maxToolCalls: 200,
    maxEmptyRetries: 3,
  },
  compaction: {
    thresholdRatio: 0.7,
    targetRatio: 0.5,
    charsPerToken: 4,
  },
  role: {
    default: "coding",
  },
  tools: {
    webFetch: {
      maxBytes: 1 * 1024 * 1024, // 1 MiB
      timeoutMs: 20_000,
    },
  },
  cli: {
    format: "text",
  },
  daemon: {
    port: 3000,
    host: "127.0.0.1",
  },
};

// ─── Source provenance ───────────────────────────────────────────────────────

/**
 * Tracks where each layer of config came from. Surfaced by
 * `huko config show` so the operator can see "this came from project,
 * that came from user, that came from default". Useful for debugging
 * "why is this value not what I set?".
 */
export type ConfigSourceLayer = {
  source: "default" | "user" | "project" | "env" | "explicit";
  path?: string;
  /** The raw object loaded from that source — pre-merge. */
  raw: Partial<HukoConfig>;
};
