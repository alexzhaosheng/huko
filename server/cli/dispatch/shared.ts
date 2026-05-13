/**
 * server/cli/dispatch/shared.ts
 *
 * Argv-parsing primitives shared by every dispatcher:
 *
 *   - `CliExitError` — thrown by `usage()` to bubble an exit code up
 *     to `cli/index.ts` without an early process.exit().
 *   - `usage(exitCode)` — render help to stdout/stderr and throw.
 *   - `parseFormatFlags()` — pluck `--format` / `--json` / `--jsonl`
 *     out of argv for list-style subcommands.
 *
 * The big help-banner content (~150 lines of static text) lives in
 * `help.ts` — editing the help text shouldn't touch the parser, and
 * neither concern should ever grow past one file.
 */

import { renderHelpText } from "./help.js";

export class CliExitError extends Error {
  readonly code: number;
  constructor(code: number, message?: string) {
    super(message ?? `huko exited with code ${code}`);
    this.code = code;
    this.name = "CliExitError";
  }
}

/**
 * Write the help banner and throw `CliExitError(exitCode)`. Use
 * `exitCode === 0` for the explicit `-h` / `--help` path (writes to
 * stdout, no error tint); use the default `3` for argv-error fallback
 * (writes to stderr).
 *
 * Marked `never` so callers can use it as a control-flow sink without
 * TypeScript thinking subsequent code is reachable.
 */
export function usage(exitCode: number = 3): never {
  const out = exitCode === 0 ? process.stdout : process.stderr;
  const stream = exitCode === 0 ? "stdout" : "stderr";
  out.write(renderHelpText(stream));
  throw new CliExitError(exitCode);
}

/**
 * Walk argv pulling out --format / --json / --jsonl flags.
 *
 * Used by list-style subcommands (sessions list, provider list, model
 * list) that don't take a free-text prompt. The `huko` parser does
 * NOT use this — it has its own strict sentinel-based parser in
 * dispatch/run.ts.
 */
export function parseFormatFlags<F extends string>(
  argv: string[],
  validFormats: readonly F[],
  defaultFormat: F,
): { format: F; positional: string[] } {
  let format: F = defaultFormat;
  const positional: string[] = [];

  for (const arg of argv) {
    if (arg === "-h" || arg === "--help") usage(0);
    if (arg === "--json") {
      assertFormat("json", validFormats);
      format = "json" as F;
      continue;
    }
    if (arg === "--jsonl") {
      assertFormat("jsonl", validFormats);
      format = "jsonl" as F;
      continue;
    }
    if (arg.startsWith("--format=")) {
      const v = arg.slice("--format=".length);
      assertFormat(v, validFormats);
      format = v as F;
      continue;
    }
    if (arg.startsWith("--")) {
      process.stderr.write(`huko: unknown flag: ${arg}\n`);
      usage();
    }
    positional.push(arg);
  }

  return { format, positional };
}

function assertFormat<F extends string>(value: string, validFormats: readonly F[]): void {
  if (!validFormats.includes(value as F)) {
    process.stderr.write(
      `huko: invalid format value: ${value} (allowed: ${validFormats.join(", ")})\n`,
    );
    usage();
  }
}
