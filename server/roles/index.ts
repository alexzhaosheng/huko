/**
 * server/roles/index.ts
 *
 * Role loader. A "role" is a markdown file (with optional YAML
 * frontmatter) holding capability-specific best-practices. After the
 * 2026-05 redesign, roles are NO LONGER static persona overlays for the
 * system prompt — they exist only as a data source for `plan` tool's
 * per-phase `capabilities` injection.
 *
 * The only consumer is `server/task/best-practices.ts`. It pulls the
 * `## Best Practices` section out of the role body and injects it into
 * the tool_result when a plan phase tagged with that capability becomes
 * active.
 *
 * Storage layers, checked in order (first match wins):
 *
 *   1. <project>/.huko/roles/<name>.md         — project-local override
 *   2. ~/.huko/roles/<name>.md                  — user-global override
 *   3. BUILTIN_ROLES (in-memory, bundled)       — shipped with huko
 *
 * Frontmatter (optional `---` fence at top). Only `description` is read;
 * unrecognised keys are silently ignored for forward compatibility:
 *
 *   description: "Short human-readable summary"
 */

import { readFile } from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { BUILTIN_ROLES } from "./builtin-roles.js";
import { parseYamlSubset } from "./yaml-frontmatter.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export type RoleFrontmatter = {
  /** Short human-readable summary, useful for `huko roles list`. */
  description?: string;
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
  // Two filesystem layers (project + user) plus a memory layer (builtin).
  // Filesystem layers shadow the built-in if present; the built-in map
  // is bundled into dist/cli.js so it works in any install layout.
  const fsLayers: Array<{ source: Role["source"]; path: string }> = [
    { source: "project", path: path.join(projectRolesDir(cwd), `${name}.md`) },
    { source: "user", path: path.join(userRolesDir(), `${name}.md`) },
  ];

  for (const c of fsLayers) {
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

  // Built-in fallback: BUILTIN_ROLES is `{ name: rawMarkdown }`. Source
  // for diagnostics is a synthetic identifier since there's no real path.
  const builtinRaw = BUILTIN_ROLES[name];
  if (builtinRaw !== undefined) {
    const synthetic = `(builtin: ${name})`;
    const { frontmatter: fmRaw, body: bodyRaw } = splitFrontmatter(builtinRaw);
    const frontmatter = fmRaw === null ? {} : parseFrontmatter(fmRaw, synthetic);
    return {
      name,
      source: "builtin",
      path: synthetic,
      frontmatter,
      body: bodyRaw.trim(),
    };
  }

  const builtinNames = Object.keys(BUILTIN_ROLES).sort();
  throw new Error(
    `Role "${name}" not found. Searched:\n` +
      fsLayers.map((c) => `  - ${c.path} (${c.source})`).join("\n") +
      `\n  - built-in roles: ${builtinNames.join(", ") || "(none)"}`,
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
