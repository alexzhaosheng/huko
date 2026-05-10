/**
 * server/cli/commands/prompts.ts
 *
 * Interactive readline helpers for `huko setup` (and any future wizard).
 *
 * Architecture: ONE `readline.Interface` per session, shared by every
 * prompt call. Creating a fresh Interface per prompt looks tidy but
 * breaks on piped stdin — readline buffers eagerly and closing one
 * Interface drops subsequent input.
 *
 * Usage:
 *   const p = openPrompter();
 *   try {
 *     const scope = await p.select(...);
 *     const name = await p.prompt(...);
 *     const value = await p.promptHidden(...);
 *   } finally {
 *     p.close();
 *   }
 *
 * All prompts read from stdin, write to stderr (so they never pollute
 * machine-readable stdout for piped consumers).
 *
 * Cancellation: throws `PromptCancelled` on Ctrl+C / Ctrl+D so the
 * caller can bail out cleanly with exit code 130.
 *
 * Hidden input: `promptHidden` uses raw-mode + manual byte parsing so
 * keys aren't echoed. When stdin isn't a TTY (piped input — common in
 * tests / scripted setups), it falls back to a plain readline read
 * with a stderr warning rather than hanging.
 */

import {
  createInterface,
  type Interface as ReadlineInterface,
} from "node:readline";
import { bold, cyan, dim, red } from "../colors.js";

export class PromptCancelled extends Error {
  constructor() {
    super("prompt cancelled");
    this.name = "PromptCancelled";
  }
}

export type PromptOptions = {
  /** Default value if the user presses ENTER on an empty line. */
  default?: string;
  /**
   * Validator. Return null/undefined for OK; return a string to display
   * as an error and re-prompt.
   */
  validate?: (value: string) => string | null | undefined;
};

export type SelectItem<T> = {
  value: T;
  label: string;
  /** Extra text rendered after the label (e.g. URL, count). */
  hint?: string;
};

export type SelectOptions = {
  /** 1-based index of the default. Defaults to 1. */
  defaultIndex?: number;
};

export type Prompter = {
  prompt(question: string, opts?: PromptOptions): Promise<string>;
  confirm(question: string, defaultYes?: boolean): Promise<boolean>;
  select<T>(
    question: string,
    items: SelectItem<T>[],
    opts?: SelectOptions,
  ): Promise<T>;
  promptHidden(question: string): Promise<string>;
  close(): void;
};

// ─── Open / close ───────────────────────────────────────────────────────────

export function openPrompter(): Prompter {
  // Implementation note: we use a single 'line' event handler with a
  // queue, NOT rl.question per call. readline.question has subtle
  // re-entrancy / buffering issues on piped stdin — questions issued
  // back-to-back can lose lines that were already buffered. The queue
  // pattern is rock solid: every line readline emits goes into the
  // queue, every prompt takes one from the queue (waiting if empty).
  let rl: ReadlineInterface | null = createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: process.stdin.isTTY ? true : false,
  });

  const lineQueue: string[] = [];
  const waiters: Array<(line: string) => void> = [];
  let closed = false;
  const closeWaiters: Array<() => void> = [];

  rl.on("line", (line) => {
    const w = waiters.shift();
    if (w) w(line);
    else lineQueue.push(line);
  });
  rl.on("close", () => {
    closed = true;
    // Drain any pending close waiters; takeLine() will see `closed`
    // and reject with PromptCancelled on its own.
    for (const cw of closeWaiters) cw();
    closeWaiters.length = 0;
  });

  function takeLine(): Promise<string> {
    if (lineQueue.length > 0) return Promise.resolve(lineQueue.shift()!);
    if (closed) return Promise.reject(new PromptCancelled());
    return new Promise<string>((resolve, reject) => {
      waiters.push(resolve);
      const onClose = (): void => {
        const idx = waiters.indexOf(resolve);
        if (idx >= 0) waiters.splice(idx, 1);
        reject(new PromptCancelled());
      };
      closeWaiters.push(onClose);
    });
  }

  function writePrompt(s: string): void {
    process.stderr.write(s);
  }

  return {
    async prompt(question, opts = {}) {
      while (true) {
        const suffix =
          opts.default !== undefined && opts.default !== ""
            ? dim(` [${opts.default}]`, "stderr")
            : "";
        writePrompt(`${question}${suffix}: `);
        const answer = await takeLine();
        const trimmed = answer.trim();
        const value =
          trimmed === "" && opts.default !== undefined ? opts.default : trimmed;
        const err = opts.validate?.(value);
        if (err) {
          process.stderr.write(red(`  ✗ ${err}`, "stderr") + "\n");
          continue;
        }
        return value;
      }
    },

    async confirm(question, defaultYes = true) {
      const hint = defaultYes ? dim("[Y/n]", "stderr") : dim("[y/N]", "stderr");
      while (true) {
        writePrompt(`${question} ${hint}: `);
        const ans = (await takeLine()).trim().toLowerCase();
        if (ans === "") return defaultYes;
        if (ans === "y" || ans === "yes") return true;
        if (ans === "n" || ans === "no") return false;
        process.stderr.write(red("  ✗ please answer y or n", "stderr") + "\n");
      }
    },

    async select(question, items, opts = {}) {
      if (items.length === 0) throw new Error("select: empty items");
      const def = opts.defaultIndex ?? 1;

      process.stderr.write(bold(question, "stderr") + "\n");
      const idxWidth = String(items.length).length;
      for (let i = 0; i < items.length; i++) {
        const num = String(i + 1).padStart(idxWidth, " ");
        const hint = items[i]!.hint ? dim(`   ${items[i]!.hint}`, "stderr") : "";
        process.stderr.write(`  ${cyan(num + ")", "stderr")} ${items[i]!.label}${hint}\n`);
      }

      while (true) {
        writePrompt(`> ${dim(`[${def}]`, "stderr")}: `);
        const ans = (await takeLine()).trim();
        const n = ans === "" ? def : Number(ans);
        if (Number.isInteger(n) && n >= 1 && n <= items.length) {
          return items[n - 1]!.value;
        }
        process.stderr.write(red(`  ✗ pick a number 1..${items.length}`, "stderr") + "\n");
      }
    },

    /**
     * Read a line without echoing. On non-TTY stdin (piped, scripted)
     * we fall back to the visible takeLine() path — better than
     * hanging on raw-mode ops that won't fire.
     */
    async promptHidden(question) {
      const stdin = process.stdin;
      const stderr = process.stderr;

      if (!stdin.isTTY) {
        stderr.write(
          `${question} (warning: stdin is not a TTY; input will be visible)\n> `,
        );
        return await takeLine();
      }

      // Pause the shared readline while we own raw stdin, otherwise
      // both will compete for keystrokes.
      rl?.pause();
      stderr.write(`${question}: `);
      try {
        return await readHiddenRaw();
      } finally {
        rl?.resume();
      }
    },

    close() {
      if (rl) {
        const it = rl;
        rl = null;
        it.close();
      }
    },
  };
}

function readHiddenRaw(): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    const stderr = process.stderr;
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    let buf = "";

    const onData = (chunk: string): void => {
      for (const ch of chunk) {
        const code = ch.charCodeAt(0);
        if (ch === "\r" || ch === "\n") {
          stderr.write("\n");
          cleanup();
          resolve(buf);
          return;
        }
        if (code === 0x03) {
          stderr.write("\n");
          cleanup();
          reject(new PromptCancelled());
          return;
        }
        if (code === 0x04 && buf.length === 0) {
          stderr.write("\n");
          cleanup();
          reject(new PromptCancelled());
          return;
        }
        if (code === 0x7f || code === 0x08) {
          if (buf.length > 0) {
            buf = buf.slice(0, -1);
            stderr.write("\b \b");
          }
          continue;
        }
        if (code < 0x20) continue;
        buf += ch;
        stderr.write("*");
      }
    };

    const cleanup = (): void => {
      stdin.off("data", onData);
      stdin.setRawMode(wasRaw);
      stdin.pause();
    };

    stdin.on("data", onData);
  });
}
