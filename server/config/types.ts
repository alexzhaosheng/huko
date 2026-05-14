/**
 * server/config/types.ts
 *
 * The single typed schema for huko's configuration.
 */

// ─── Safety policy primitives ───────────────────────────────────────────────

export type SafetyAction = "auto" | "prompt" | "deny";

export type ToolSafetyRules = {
  /**
   * When true, the tool is removed from the LLM's tool surface entirely
   * — both full and lean modes — as if it weren't registered. The LLM
   * never sees the tool's name, schema, or description, so it can't try
   * to call it. This is stronger than `deny` (which would let the LLM
   * call the tool and then refuse at execution); use `disabled` when you
   * want the capability genuinely absent rather than guarded.
   *
   * Layered: project layer's `disabled: true` overrides global. There's
   * no way to "re-enable" from a lower layer if a higher one disables —
   * remove the field, don't set it to `false`. (`disabled: false` is
   * treated identically to absent for clarity.)
   */
  disabled?: boolean;
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
   * → <cwd>/.huko/config.json → env → explicit. CLI `--lean` flag
   * is an explicit override for a single call.
   *
   * Stored as a string enum (not a boolean) so future modes (e.g. a
   * coding-only profile) plug in without breaking the schema.
   */
  mode: "lean" | "full";

  task: {
    maxIterations: number;
    maxToolCalls: number;
    maxEmptyRetries: number;
    /**
     * Abort an LLM call if no stream chunk (or final response, for
     * non-streaming) arrives in this many milliseconds. Prevents the
     * "provider holds the socket but never sends data" hang documented
     * in `llm-call.ts` heartbeat block. Set to 0 to disable.
     */
    llmIdleTimeoutMs: number;
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
    browser: {
      /** WebSocket port for the Chrome extension to connect to. */
      wsPort: number;
      /** Per-action timeout in milliseconds. */
      defaultTimeoutMs: number;
      /** Maximum screenshot image size in bytes (5 MiB default). */
      maxScreenshotBytes: number;
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
    /**
     * Layer 2 of the redaction system: regex patterns matched against
     * every outbound message. Matches get replaced with placeholders
     * (`[REDACTED:<name>]`) and recorded in the session-substitution
     * table so the inverse direction (placeholder → raw) works for
     * tool calls the LLM emits with the placeholder.
     *
     * The shipped built-in pack
     * (`server/security/builtin-redact-patterns.ts`) covers OpenAI /
     * Anthropic / GitHub / AWS / Google / Slack / PEM / JWT shapes —
     * always-on, not configurable from here. This field is for
     * **adding** patterns specific to your environment (corporate
     * gateway tokens, internal hostnames, etc.). Write user patterns
     * carefully — anything that matches normal text will redact it.
     *
     * Layered: union across layers (additive), same as toolRules
     * arrays. Project never silently relaxes a global redaction.
     */
    redactPatterns?: Array<{ name: string; pattern: string }>;
  };

  cli: {
    format: "text" | "jsonl" | "json";
    /**
     * Default verbosity for the `text` formatter:
     *   - false (default): tool_result content + system_reminder body
     *     are hidden — too noisy and primarily useful to the LLM, not
     *     the operator watching at a terminal.
     *   - true:            full preview / full reminder body (parity
     *     with how huko looked before the 2026-05 trim).
     *
     * Per-call `--verbose` / `-v` flag overrides this.
     */
    verbose: boolean;
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
    // 2 minutes — comfortably long for slow time-to-first-token on
    // thinking models, short enough that a hung provider doesn't leave
    // the task spinning forever. Bug: hukoDev session 4 task 28 hung
    // indefinitely with this set to (effectively) Infinity.
    llmIdleTimeoutMs: 120_000,
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
    browser: {
      wsPort: 19222,
      defaultTimeoutMs: 30_000,
      maxScreenshotBytes: 5 * 1024 * 1024,
    },
  },
  cli: {
    format: "text",
    verbose: false,
  },
  daemon: {
    port: 3000,
    host: "127.0.0.1",
  },
  safety: {
    // Safety is OPT-IN. Zero-config huko behaves identically to pre-
    // safety-layer huko: every tool just runs. Users who want safety
    // explicitly call `huko safety init` (which scaffolds a template
    // with `dangerous: "prompt"` + read-only bash allow-list) and
    // tune from there.
    //
    // Why not default to prompt: a `-y` / non-interactive run with
    // `dangerous: prompt` fails-closed for EVERY bash call (no port
    // installed → deny). That'd silently break every CI/script that
    // worked yesterday. Opt-in keeps the upgrade path clean.
    byDangerLevel: {
      safe: "auto",
      moderate: "auto",
      dangerous: "auto",
    },
    toolRules: {},
    // Layer 1 path-deny defaults are NOT baked into DEFAULT_CONFIG —
    // they go through the `huko safety init` scaffold instead. Why:
    // (1) "explicit configuration" — the user sees what's protecting
    // them, can edit / extend / `safety unset` individual rules;
    // (2) regex-on-bash-args only catches the literal `cat .env`
    // shape, missing `nano`, `python -c "open(...)"`, etc. Pretending
    // those are blocked would give false confidence. The scaffold
    // pairs the default rules with comments calling out the
    // limitation and pointing at `huko docker run` for real isolation.
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
