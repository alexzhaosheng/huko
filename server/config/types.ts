/**
 * server/config/types.ts
 *
 * The single typed schema for huko's configuration.
 */

// ─── Schema ──────────────────────────────────────────────────────────────────

export type HukoConfig = {
  task: {
    maxIterations: number;
    maxToolCalls: number;
    maxEmptyRetries: number;
  };

  compaction: {
    thresholdRatio: number;
    targetRatio: number;
    charsPerToken: number;
  };

  role: {
    default: string;
  };

  tools: {
    webFetch: {
      maxBytes: number;
      timeoutMs: number;
    };
    webSearch: {
      /**
       * Search backend. v1 ships only `duckduckgo` (no API key needed,
       * scrapes the HTML endpoint). Future providers plug in by name.
       */
      provider: "duckduckgo";
      timeoutMs: number;
      maxResults: number;
    };
  };

  cli: {
    format: "text" | "jsonl" | "json";
  };

  daemon: {
    port: number;
    host: string;
  };
};

// ─── Built-in defaults ───────────────────────────────────────────────────────

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
    default: "general",
  },
  tools: {
    webFetch: {
      maxBytes: 1 * 1024 * 1024,
      timeoutMs: 20_000,
    },
    webSearch: {
      provider: "duckduckgo",
      timeoutMs: 15_000,
      maxResults: 10,
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
 * `huko config show` so the operator can see which file set what.
 */
export type ConfigSourceLayer = {
  source: "default" | "user" | "project" | "env" | "explicit";
  path?: string;
  raw: Partial<HukoConfig>;
};
