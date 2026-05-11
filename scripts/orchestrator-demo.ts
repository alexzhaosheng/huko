/**
 * scripts/orchestrator-demo.ts
 *
 * STUB — the standalone orchestrator demo seeded an OpenRouter setup
 * into the SQLite infra DB. Provider/model config has moved to layered
 * JSON files (~/.huko/providers.json, <cwd>/.huko/providers.json), so
 * the equivalent flow is:
 *
 *   1. Built-in defaults already include OpenRouter — see
 *      server/config/builtin-providers.ts.
 *   2. Set the key once: `huko keys set openrouter <your-key>`
 *   3. Pick a model: `huko model default openrouter/anthropic/claude-sonnet-4.5`
 *   4. Run: `huko ...`
 *
 * If you want to script that, do it with the CLI commands above; this
 * demo no longer has anything unique to demonstrate.
 */
process.stderr.write(
  "scripts/orchestrator-demo.ts: removed — see file header for the equivalent CLI flow.\n",
);
process.exit(0);
