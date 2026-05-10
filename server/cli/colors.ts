/**
 * server/cli/colors.ts
 *
 * TTY-aware ANSI color helpers + semantic shortcuts.
 *
 * Two layers of API:
 *
 *   1. Raw style helpers — `bold(s)`, `dim(s)`, `cyan(s)`, etc. Return
 *      `s` unchanged when the relevant stream isn't a TTY OR when the
 *      `NO_COLOR` env var is set (the de-facto standard, see no-color.org).
 *
 *   2. Semantic shortcuts — `source(name, layer)`, `keyStatus(label, layer)`,
 *      `error/warning/success/header`. These encode huko's meaning so
 *      every command that surfaces "this came from the global layer"
 *      paints it the same blue.
 *
 * Color scheme (semantic):
 *   - global    → blue       (machine-wide setting)
 *   - project   → green      (this directory's setting; commit-friendly)
 *   - builtin   → dim/gray   (shipped with huko)
 *   - unset     → yellow     (recoverable, action needed)
 *   - unresolved/error → red (broken state)
 *   - success   → green
 *   - header    → bold
 *   - emphasis  → cyan       (names: provider, model, file paths)
 *
 * Stream awareness: each helper accepts an optional stream
 * (`stdout`/`stderr`) so the same call site can color stdout output
 * with stdout's TTY check, etc. Default stream is stdout.
 */

import type { ConfigSource } from "../config/infra-config-types.js";
import type { KeySourceLayer } from "../security/keys.js";

// ─── Detection ──────────────────────────────────────────────────────────────

const NO_COLOR = process.env["NO_COLOR"] !== undefined && process.env["NO_COLOR"] !== "";
const FORCE_COLOR =
  process.env["FORCE_COLOR"] !== undefined && process.env["FORCE_COLOR"] !== "0";

export type ColorStream = "stdout" | "stderr";

/**
 * True when we should emit ANSI escapes for `stream`. Honours NO_COLOR
 * (off) and FORCE_COLOR (on), then falls back to the actual TTY check.
 */
export function colorEnabled(stream: ColorStream = "stdout"): boolean {
  if (NO_COLOR) return false;
  if (FORCE_COLOR) return true;
  return stream === "stdout" ? process.stdout.isTTY === true : process.stderr.isTTY === true;
}

// ─── Raw style helpers ──────────────────────────────────────────────────────

function wrap(open: number, close: number) {
  return (s: string, stream: ColorStream = "stdout"): string => {
    if (!colorEnabled(stream)) return s;
    return `\x1b[${open}m${s}\x1b[${close}m`;
  };
}

export const bold = wrap(1, 22);
export const dim = wrap(2, 22);
export const italic = wrap(3, 23);
export const underline = wrap(4, 24);

export const red = wrap(31, 39);
export const green = wrap(32, 39);
export const yellow = wrap(33, 39);
export const blue = wrap(34, 39);
export const magenta = wrap(35, 39);
export const cyan = wrap(36, 39);
export const gray = dim; // alias

// ─── Semantic shortcuts ─────────────────────────────────────────────────────

/** Color a string by its config-source layer (global/project/builtin). */
export function source(
  s: string,
  layer: ConfigSource,
  stream: ColorStream = "stdout",
): string {
  switch (layer) {
    case "global":
      return blue(s, stream);
    case "project":
      return green(s, stream);
    case "builtin":
      return dim(s, stream);
  }
}

/** Color a key-resolution layer label. */
export function keyStatus(
  s: string,
  layer: KeySourceLayer,
  stream: ColorStream = "stdout",
): string {
  switch (layer) {
    case "project":
      return green(s, stream);
    case "global":
      return blue(s, stream);
    case "env":
      return cyan(s, stream);
    case "dotenv":
      return cyan(s, stream);
    case "unset":
      return yellow(s, stream);
  }
}

export function header(s: string, stream: ColorStream = "stdout"): string {
  return bold(s, stream);
}

export function emphasis(s: string, stream: ColorStream = "stdout"): string {
  return cyan(s, stream);
}

export function error(s: string, stream: ColorStream = "stderr"): string {
  return red(s, stream);
}

export function warning(s: string, stream: ColorStream = "stderr"): string {
  return yellow(s, stream);
}

export function success(s: string, stream: ColorStream = "stdout"): string {
  return green(s, stream);
}

/**
 * Length of a string with all ANSI escape sequences stripped. Used by
 * tables to compute correct column widths even when cells contain
 * color codes.
 */
export function visibleLength(s: string): number {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

/**
 * Pad to `width` based on visible (uncolored) length, not raw length.
 * Use this in tables where cells may carry ANSI codes.
 */
export function padVisible(s: string, width: number): string {
  const len = visibleLength(s);
  return len >= width ? s : s + " ".repeat(width - len);
}
