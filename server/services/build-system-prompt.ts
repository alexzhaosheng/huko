/**
 * server/services/build-system-prompt.ts
 *
 * The single composer for huko's system prompt.
 *
 * Composition order (deterministic, no magic):
 *
 *   1. role.body                    — from server/roles/<name>.md (or user/project override)
 *   2. project context              — <project>/CLAUDE.md if present
 *   3. dynamic environment block    — cwd, current date, OS
 *
 * Anything that influences the LLM's behaviour MUST flow through this
 * function. Tool descriptions are appended downstream by the LLM-call
 * pipeline (tool-call XML mode embeds them; native mode passes them
 * via the API surface) — they are NOT part of the system prompt.
 *
 * Why this lives in services/ and not engine/: composition is a
 * setup-time concern (what string does this task start with?), not a
 * runtime concern. The engine doesn't care how the string was built;
 * it just receives `taskContext.systemPrompt`. Keeping the composer in
 * the services layer keeps engine/ free of file-system reads.
 */

import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { type Role } from "../roles/index.js";

export type BuildSystemPromptOptions = {
  role: Role;
  /** Working directory the task runs in. Used to find project-level CLAUDE.md. */
  cwd: string;
};

/**
 * Build the full system prompt for a task. Pure-ish: depends only on
 * the role body and a one-time read of `<cwd>/CLAUDE.md` if present.
 * No I/O on tools or providers.
 */
export async function buildSystemPrompt(
  opts: BuildSystemPromptOptions,
): Promise<string> {
  const parts: string[] = [];

  // 1. Role body (the bulk of the prompt)
  parts.push(opts.role.body);

  // 2. Project-level CLAUDE.md (Claude Code / Cursor convention — auto-loaded
  //    if present in the project root). Inclusion is on by default to play
  //    nicely with users who already have one for their other tooling.
  const projectClaude = await tryReadFile(path.join(opts.cwd, "CLAUDE.md"));
  if (projectClaude) {
    parts.push(
      "# Project context (from CLAUDE.md)\n\n" + projectClaude.trim(),
    );
  }

  // 3. Dynamic environment block (cwd, date, platform). Stable enough
  //    within a single task run, but rebuilt per-task so the model sees
  //    the right cwd if the user runs from a different directory.
  parts.push(buildEnvBlock(opts.cwd));

  return parts.join("\n\n---\n\n");
}

// ─── Internals ───────────────────────────────────────────────────────────────

async function tryReadFile(p: string): Promise<string | null> {
  try {
    return await readFile(p, "utf8");
  } catch (err: unknown) {
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code: string }).code === "ENOENT"
    ) {
      return null;
    }
    throw err;
  }
}

function buildEnvBlock(cwd: string): string {
  const date = new Date().toISOString().slice(0, 10);
  const platform = process.platform;
  return [
    "# Environment",
    "",
    `- Working directory: ${cwd}`,
    `- Date: ${date}`,
    `- Platform: ${platform}`,
  ].join("\n");
}
