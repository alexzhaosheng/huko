/**
 * server/cli/formatters/markdown.ts
 *
 * Markdown-to-terminal rendering via marked + marked-terminal.
 *
 * Only call renderMd() when stdout is a TTY — if the output is piped
 * to a file or another process, raw Markdown is the correct format
 * (ANSI codes in a file are noise).
 *
 * The renderer is configured once, lazily — `marked.use()` is a global
 * mutation, so we guard it with a flag.
 */

import { marked } from "marked";
import { markedTerminal } from "marked-terminal";
import type TerminalRenderer from "marked-terminal";

let _configured = false;

/**
 * Wire marked-terminal into marked's pipeline.
 *
 * marked-terminal v7 returns an old-style Renderer (TerminalRenderer).
 * Marked v15's public `use()` signature expects `MarkedExtension`,
 * but at runtime it also accepts a bare Renderer object with standard
 * renderer methods (heading, code, table, paragraph, ...).  This is
 * the documented legacy compat path in marked-terminal's README.
 *
 * We suppress the type error rather than casting: if a future
 * marked-terminal version ships proper `MarkedExtension` support,
 * the suppression turns into a compile error (expected-not-present),
 * signalling that this adapter can be dropped.
 */
function installTerminalRenderer(): void {
  const opts = {
    reflowText: false,
    showSectionPrefix: false,
    width: Math.min(process.stderr.columns ?? 80, 120),
    tab: 2,
  };
  const renderer: TerminalRenderer = markedTerminal(opts);
  // @ts-expect-error — marked-terminal returns old-style Renderer; marked v15 accepts it at runtime (legacy compat, see marked/src/Instance.ts:use()).
  // TODO(upstream): drop `@ts-expect-error` and use `marked.use( markedTerminal(opts) )` directly when marked-terminal ships MarkedExtension-compatible types.
  marked.use(renderer);
}

/**
 * Render a markdown string to an ANSI-styled terminal string.
 *
 * By default only renders when stdout is a TTY (piped consumers
 * get raw markdown). Pass `target: "stderr"` for diagnostic output
 * (info messages, tool results in verbose mode) where rendering is
 * always appropriate.
 */
export function renderMd(
  text: string,
  opts?: { target?: "stdout" | "stderr" },
): string {
  const target = opts?.target ?? "stdout";
  if (target === "stdout" && !process.stdout.isTTY) return text;
  if (target === "stderr" && !process.stderr.isTTY) return text;
  if (text.length === 0) return text;

  try {
    if (!_configured) { installTerminalRenderer(); _configured = true; }
    const rendered = marked.parse(text, { async: false });
    // marked.parse returns string | Promise<string>; in sync mode it's always string
    if (typeof rendered !== "string") return text;
    return rendered.trimEnd();
  } catch {
    // Never crash on bad markdown — fall back to raw text.
    return text;
  }
}
