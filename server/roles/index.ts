/**
 * server/roles/index.ts
 *
 * Role loader. A "role" is a markdown file with optional YAML frontmatter,
 * whose body becomes (most of) the system prompt. Roles are the "scenario
 * / persona" mechanism for huko — the user picks one with `--role=<name>`
 * (default: `coding`).
 *
 * Storage layers, checked in order (first match wins):
 *
 *   1. <project>/.huko/roles/<name>.md         — project-local override
 *   2. ~/.huko/roles/<name>.md                  — user-global override
 *   3. <huko repo>/server/roles/<name>.md       — built-in (this directory)
 *
 * Frontmatter is optional and lives in a `---` fence at the top of the file.
 * Recognised keys (everything else is silently ignored — forward-compat):
 *
 *   description: "Short human-readable summary"
 *   model: "claude-sonnet-4"        # logical id; resolved to numeric model.id
 *                                   # later by the orchestrator (see TODO)
 *   tools:
 *     allow: [shell, file, web_fetch, message]   # whitelist (omit = all allowed)
 *     deny:  [browser_open]                       # blacklist (always wins over allow)
 *
 * Why this design — mirroring [audit-2026-05.md] decision:
 *   - One markdown body is still the bulk of the role (no fragmenting into
 *     identity / language / capabilities like WeavesAI's chat-agent.json).
 *   - Frontmatter only carries fields with a real runtime consumer.
 *     `description` shows up in `huko roles list` (TODO). `tools.{allow,deny}`
 *     plug into `getToolsForLLM(filterContext)`. `model` will resolve to a
 *     numeric model id once `models.findByLogicalId(string)` lands.
 *   - Future per-user / per-task tool toggles compose with this by
 *     intersecting `allowedTools` lists and unioning `deniedTools` lists
 *     before calling `getToolsForLLM`. No interface change required.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import * as os from "node:os";
import { parseYamlSubset } from "./yaml-frontmatter.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export type RoleFrontmatter = {
  /** Short human-readable summary, useful for `huko roles list`. */
  description?: string;
  /**
   * Logical model identifier (string). The orchestrator resolves this to
   * a numeric `models.id` via persistence. If the role specifies a model
   * but no provider has it registered, role loading still succeeds — the
   * mismatch is reported when the task starts.
   *
   * NOTE: not yet wired through. See TODO(role-model) in
   * task-orchestrator.ts.
   */
  model?: string;
  /** Per-role tool gating. Both lists are optional. */
  tools?: {
    /**
     * If set, ONLY these tools are visible to the LLM. Omit (or use an
     * empty undefined) to allow all registered tools.
     */
    allow?: string[];
    /**
     * Tools that are always hidden, regardless of `allow`. Wins ties.
     */
    deny?: string[];
  };
};

export type Role = {
  /** The role's stable identifier (matches the filename without extension). */
  name: string;
  /**
   * Where this role was loaded from — useful for diagnostics and the
   * `huko roles list` command.
   */
  source: "project" | "user" | "builtin";
  /** Absolute path to the markdown file the body came from. */
  path: string;
  /** Parsed YAML frontmatter; `{}` when the file has no fence. */
  frontmatter: RoleFrontmatter;
  /** Markdown body (frontmatter stripped) — becomes the system prompt's first block. */
  body: string;
};

// ─── Path resolution ─────────────────────────────────────────────────────────

/**
 * Resolve the built-in roles directory. Computes from this module's
 * location so it works regardless of how huko was invoked / installed.
 */
function builtinRolesDir(): string {
  const here = fileURLToPath(import.meta.url);
  // here = .../server/roles/index.{ts,js}
  return path.dirname(here);
}

function userRolesDir(): string {
  return path.join(os.homedir(), ".huko", "roles");
}

function projectRolesDir(cwd: string): string {
  return path.join(cwd, ".huko", "roles");
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Load a role by name. Throws with a helpful message if no source has it.
 *
 * `cwd` lets the caller pass an explicit project root; defaults to
 * `process.cwd()`. CLI threads `process.cwd()` through; tests can
 * inject a fixture dir.
 */
export async function loadRole(
  name: string,
  cwd: string = process.cwd(),
): Promise<Role> {
  const candidates: Array<{ source: Role["source"]; path: string }> = [
    { source: "project", path: path.join(projectRolesDir(cwd), `${name}.md`) },
    { source: "user", path: path.join(userRolesDir(), `${name}.md`) },
    { source: "builtin", path: path.join(builtinRolesDir(), `${name}.md`) },
  ];

  for (const c of candidates) {
    const raw = await tryRead(c.path);
    if (raw === null) continue;

    const { frontmatter: fmRaw, body: bodyRaw } = splitFrontmatter(raw);
    const frontmatter = fmRaw === null ? {} : parseFrontmatter(fmRaw, c.path);

    return {
      name,
      source: c.source,
      path: c.path,
      frontmatter,
      body: bodyRaw.trim(),
    };
  }

  throw new Error(
    `Role "${name}" not found. Searched:\n` +
      candidates.map((c) => `  - ${c.path} (${c.source})`).join("\n"),
  );
}

// ─── Frontmatter handling ────────────────────────────────────────────────────

/**
 * Split a `---\n...\n---` fence off the top of the file.
 *
 * If no fence exists at the very start, the whole input becomes `body`
 * and frontmatter is `null`. The fence delimiter must be `---` on its
 * own line; we don't recognise `+++` (TOML-style) or any other variant.
 */
function splitFrontmatter(
  raw: string,
): { frontmatter: string | null; body: string } {
  // Tolerate UTF-8 BOM at file start.
  const noBom = raw.startsWith("﻿") ? raw.slice(1) : raw;

  const openMatch = /^---[ \t]*\r?\n/.exec(noBom);
  if (!openMatch) return { frontmatter: null, body: raw };

  const afterOpen = noBom.slice(openMatch[0].length);
  const closeMatch = /\r?\n---[ \t]*(?:\r?\n|$)/.exec(afterOpen);
  if (!closeMatch) return { frontmatter: null, body: raw };

  const fmRaw = afterOpen.slice(0, closeMatch.index);
  const body = afterOpen.slice(closeMatch.index + closeMatch[0].length);
  return { frontmatter: fmRaw, body };
}

function parseFrontmatter(fmRaw: string, sourcePath: string): RoleFrontmatter {
  let parsed: Record<string, unknown>;
  try {
    parsed = parseYamlSubset(fmRaw) as Record<string, unknown>;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Bad frontmatter in ${sourcePath}: ${msg}`);
  }

  const fm: RoleFrontmatter = {};

  if (typeof parsed["description"] === "string") {
    fm.description = parsed["description"];
  }
  if (typeof parsed["model"] === "string") {
    fm.model = parsed["model"];
  }

  const toolsRaw = parsed["tools"];
  if (toolsRaw && typeof toolsRaw === "object" && !Array.isArray(toolsRaw)) {
    const tools: NonNullable<RoleFrontmatter["tools"]> = {};
    const tobj = toolsRaw as Record<string, unknown>;
    if (Array.isArray(tobj["allow"])) {
      tools.allow = tobj["allow"].filter((x): x is string => typeof x === "string");
    }
    if (Array.isArray(tobj["deny"])) {
      tools.deny = tobj["deny"].filter((x): x is string => typeof x === "string");
    }
    if (tools.allow !== undefined || tools.deny !== undefined) {
      fm.tools = tools;
    }
  }

  return fm;
}

async function tryRead(p: string): Promise<string | null> {
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
