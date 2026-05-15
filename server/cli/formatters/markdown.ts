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

let _configured = false;

function ensureConfigured(): void {
  if (_configured) return;
  // markedTerminal() returns a TerminalRenderer (old-style Renderer).
  // Marked v15's types expect MarkedExtension, but at runtime the old
  // renderer API is still accepted. Cast through `any` to satisfy tsc.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  marked.use(markedTerminal({
    reflowText: false,
    showSectionPrefix: false,
    width: Math.min(process.stderr.columns ?? 80, 120),
    tab: 2,
  }) as any);
  _configured = true;
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
    ensureConfigured();
    const rendered = marked.parse(text, { async: false });
    // marked.parse returns string | Promise<string>; in sync mode it's always string
    if (typeof rendered !== "string") return text;
    return rendered.trimEnd();
  } catch {
    // Never crash on bad markdown — fall back to raw text.
    return text;
  }
}
