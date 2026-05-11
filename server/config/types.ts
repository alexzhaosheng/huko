/**
 * server/config/types.ts
 *
 * The single typed schema for huko's configuration.
 */

// ─── Safety policy primitives ───────────────────────────────────────────────

export type SafetyAction = "auto" | "prompt" | "deny";

export type ToolSafetyRules = {
  /** Patterns that — if matched — refuse the call before the handler runs. */
  deny?: string[];
  /**
   * Patterns that — if matched — bypass `requireConfirm` and the
   * dangerLevel default. `deny` still wins. Populated by the operator
   * picking "always allow" at a confirmation prompt.
   */
  allow?: string[];
  /** Patterns that — if matched — pause execution and ask the operator y/n. */
  requireConfirm?: string[];
};

// ─── Schema ──────────────────────────────────────────────────────────────────

export type HukoConfig = {
  /**
   * Agent execution mode.
   *   - "full" — the default. Full system prompt, role/project context,
   *     and the complete tool surface.
   *   - "lean" — minimal system prompt (~123 tok) + shell-only tool
   *     surface. Trades planning/tooling for ~95% smaller per-call fixed
   *     overhead. See server/services/build-lean-system-prompt.ts.
   *
   * Layered like every other field: default ("full") → ~/.huko/config.json
   * → <cwd>/.huko/config.json → env → explicit. CLI `--lean` / `--full`
   * flags are explicit overrides for a single call.
   *
   * Stored as a string enum (not a boolean) so future modes (e.g. a
   * coding-only profile) plug in without breaking the schema.
   */
  mode: "lean" | "full";

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

  /**
   * Per-tool safety policy. Layered on top of each tool's intrinsic
   * `dangerLevel` ("safe" | "moderate" | "dangerous"). The evaluator
   * lives in `server/safety/policy.ts` and runs BEFORE the tool handler
   * in `server/task/pipeline/tool-execute.ts`.
   *
   * Precedence (per call):
   *   1. `toolRules[name].deny` pattern matches  → deny (returned to LLM)
   *   2. `toolRules[name].allow` pattern matches → auto (skip prompt)
   *   3. `toolRules[name].requireConfirm` match  → prompt the operator
   *   4. fallback: `byDangerLevel[<tool's level>]`
   *
   * Pattern syntax:
   *   - Default: literal-prefix match against the relevant argument
   *     (e.g. bash matches `command`; write_file matches `path`).
   *   - `re:<regex>`: ECMAScript regex. Compile errors warn + skip.
   *
   * Layered merge:
   *   - `byDangerLevel.*`: project > global > default (replace).
   *   - `toolRules.<tool>.{deny,allow,requireConfirm}`: union across
   *     layers (additive — project never relaxes global constraints
   *     unintentionally). This is the loader's only array-merge
   *     exception; documented in `server/config/loader.ts`.
   *
   * Non-interactive runs (`-y` / HUKO_NON_INTERACTIVE=1): if a
   * `prompt` decision would fire but no `requestDecision` port is
   * installed, the call is denied (fail-closed). The LLM sees a clear
   * `policy_denied` tool_result naming the matched rule.
   */
  safety: {
    byDangerLevel: {
      safe: SafetyAction;
      moderate: SafetyAction;
      dangerous: SafetyAction;
    };
    toolRules: Record<string, ToolSafetyRules>;
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
  mode: "full",
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
  safety: {
    byDangerLevel: {
      // Read-only ops auto-execute; write/exec ops auto-execute by
      // default too — the new safety layer is opt-in. Users who want
      // confirmation for write/exec set `moderate: "prompt"`.
      safe: "auto",
      moderate: "auto",
      // `dangerous` exists for tools that should always pause unless
      // explicitly bypassed (currently no tool ships at this level).
      dangerous: "prompt",
    },
    toolRules: {},
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
