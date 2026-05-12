/**
 * server/cli/env-hints.ts
 *
 * Environment-aware diagnostic hints, attached to error messages only.
 *
 * Why a separate module:
 *   - These are *additive* to existing diagnostics — they never change
 *     control flow. Keep them out of index.ts / dispatch so the dispatch
 *     logic stays focused on routing.
 *   - Pure functions, easy to test (inject env / platform).
 *
 * Currently covers ONE case:
 *
 *   PowerShell's `--` consumption — PowerShell in `Legacy` argument-
 *   passing mode (Windows PowerShell 5.1 and PowerShell 7.2-) silently
 *   strips the `--` token before invoking external commands. Result:
 *   `huko -- 你是谁？` reaches huko as `huko 你是谁？` and trips the
 *   "unknown subcommand" branch. Git, cargo, npm hit the same bug.
 *
 *   When huko detects it's running under PowerShell AND the user landed
 *   in that error branch, we attach a three-option workaround hint.
 */

/**
 * Heuristic: are we (probably) running under PowerShell?
 *
 * Both Windows PowerShell 5.1 and PowerShell Core 7+ always set
 * `PSModulePath`. Non-PowerShell shells (bash, zsh, cmd) don't.
 *
 * False-positive: a non-PS shell launched FROM PowerShell inherits
 * `PSModulePath`. We tolerate this — the hint is purely additive and
 * still valid advice for those callers (their parent env did the
 * stripping, the workaround still applies).
 *
 * Inject env for testability; defaults to `process.env`.
 */
export function isLikelyPowerShell(env: NodeJS.ProcessEnv = process.env): boolean {
  const psModulePath = env["PSModulePath"];
  return typeof psModulePath === "string" && psModulePath.length > 0;
}

/**
 * Multi-line hint listing the three known fixes for PowerShell's `--`
 * stripping. Each option is self-contained — the user can pick whichever
 * fits their PS version + tolerance for global state.
 *
 * Format: trailing newline so callers can concatenate without worrying
 * about line gluing.
 */
export function formatPowerShellSentinelHint(): string {
  return [
    "",
    "PowerShell detected. If you typed `huko -- <prompt>` and the `--` got dropped,",
    "that's PowerShell's legacy argument passing. Fix with any of:",
    "",
    `  (a) Quote the sentinel:          huko "--" <prompt>`,
    `  (b) Switch to Standard passing:  $PSNativeCommandArgumentPassing = 'Standard'`,
    `                                   (add to $PROFILE for permanence; PS 7.3+)`,
    `  (c) Use stop-parsing token:      huko --% -- <prompt>`,
    "",
  ].join("\n");
}
