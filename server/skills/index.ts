/**
 * server/skills/index.ts
 *
 * Skill loader. A "skill" is a user-authored markdown file (YAML
 * frontmatter + body) holding operator-supplied instructions that get
 * injected into the system prompt when the skill is active.
 *
 * Distinct from `roles/`:
 *   - roles  → automatically dispatched by the planner via
 *              `plan(update).capabilities`. Model-driven, per-phase.
 *   - skills → toggled by the operator via config or `--skill=NAME`.
 *              Operator-driven, session-fixed.
 *
 * Storage layers (first match wins, by skill name):
 *   1. <project>/.huko/skills/<name>.md          — single-file project
 *   2. <project>/.huko/skills/<name>/SKILL.md    — folder-style project
 *   3. ~/.huko/skills/<name>.md                  — single-file global
 *   4. ~/.huko/skills/<name>/SKILL.md            — folder-style global
 *
 * Both layouts coexist deliberately: trivial skills are one file; skills
 * with supporting assets (referenced from the body) use a folder. The
 * folder form mirrors the de-facto agent-skill convention.
 *
 * Frontmatter — only `description` is read; unrecognised keys are
 * silently ignored so files written for other agents drop in unchanged:
 *
 *   ---
 *   description: One-line trigger / what this skill does
 *   ---
 *   <markdown body>
 */

import { readFile, readdir, stat } from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { parseYamlSubset } from "../roles/yaml-frontmatter.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export type SkillFrontmatter = {
  /** One-line description shown in the system prompt index + `skills list`. */
  description?: string;
};

export type SkillSource = "project" | "user";

export type Skill = {
  /** Stable identifier; matches the file stem or the containing folder name. */
  name: string;
  /** Which layer the skill was loaded from. */
  source: SkillSource;
  /** Absolute path to the markdown file the body came from. */
  path: string;
  /** Parsed frontmatter (`{}` when the file has no fence). */
  frontmatter: SkillFrontmatter;
  /** Markdown body (frontmatter stripped, trimmed). */
  body: string;
};

// ─── Path resolution ─────────────────────────────────────────────────────────

function userSkillsDir(): string {
  return path.join(os.homedir(), ".huko", "skills");
}

function projectSkillsDir(cwd: string): string {
  return path.join(cwd, ".huko", "skills");
}

/**
 * Build the ordered candidate file paths for one skill name. Order
 * matters — first existing file wins, so project beats user and
 * single-file beats folder-style within a layer.
 */
function candidatePaths(name: string, cwd: string): Array<{ source: SkillSource; path: string }> {
  const projectDir = projectSkillsDir(cwd);
  const userDir = userSkillsDir();
  return [
    { source: "project", path: path.join(projectDir, `${name}.md`) },
    { source: "project", path: path.join(projectDir, name, "SKILL.md") },
    { source: "user", path: path.join(userDir, `${name}.md`) },
    { source: "user", path: path.join(userDir, name, "SKILL.md") },
  ];
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Load a single skill by name. Throws with a diagnostic message listing
 * every probed path when nothing matched — the operator typed `--skill=X`
 * and we want them to see exactly where huko looked.
 */
export async function loadSkill(name: string, cwd: string = process.cwd()): Promise<Skill> {
  for (const c of candidatePaths(name, cwd)) {
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
    `Skill "${name}" not found. Searched:\n` +
      candidatePaths(name, cwd)
        .map((c) => `  - ${c.path} (${c.source})`)
        .join("\n"),
  );
}

/**
 * Enumerate every skill discoverable from `cwd`'s perspective. Used by
 * `huko skills list`. When a name exists in BOTH layers, the project
 * copy shadows global (matches `loadSkill`'s precedence).
 */
export async function listAvailableSkills(cwd: string = process.cwd()): Promise<Skill[]> {
  // Discover by layer (project first so its names win during de-dup).
  const layers: Array<{ source: SkillSource; dir: string }> = [
    { source: "project", dir: projectSkillsDir(cwd) },
    { source: "user", dir: userSkillsDir() },
  ];

  const seen = new Set<string>();
  const out: Skill[] = [];
  for (const layer of layers) {
    const names = await discoverNames(layer.dir);
    for (const name of names) {
      if (seen.has(name)) continue;
      seen.add(name);
      // Re-use loadSkill to avoid duplicating the candidate-path logic.
      try {
        out.push(await loadSkill(name, cwd));
      } catch {
        // Race: the file vanished between discovery and load. Skip silently.
      }
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/**
 * Enumerate skill names a layer directory can offer. A file `foo.md`
 * yields `foo`; a directory `foo/SKILL.md` yields `foo`. Other entries
 * (a folder without SKILL.md, a non-`.md` file at the top level) are
 * ignored — operators can drop README.md / assets next to skills
 * without polluting the index.
 */
async function discoverNames(dir: string): Promise<string[]> {
  const entries = await tryReadDir(dir);
  if (entries === null) return [];
  const names: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry);
    const info = await tryStat(full);
    if (info === null) continue;
    if (info.isFile() && entry.endsWith(".md") && entry !== "README.md") {
      names.push(entry.slice(0, -".md".length));
    } else if (info.isDirectory()) {
      const skillFile = await tryStat(path.join(full, "SKILL.md"));
      if (skillFile !== null && skillFile.isFile()) {
        names.push(entry);
      }
    }
  }
  return names;
}

// ─── Frontmatter handling ────────────────────────────────────────────────────

/**
 * Split a `---\n...\n---` fence off the top of the file. If the file
 * has no fence, returns the whole content as the body.
 */
function splitFrontmatter(raw: string): { frontmatter: string | null; body: string } {
  // Normalise leading BOM + leading blank lines so `---` is recognised
  // even when the file was saved by an editor that injected a UTF-8 BOM.
  const cleaned = raw.replace(/^﻿/, "");
  if (!cleaned.startsWith("---")) {
    return { frontmatter: null, body: cleaned };
  }
  const lines = cleaned.split(/\r?\n/);
  // First line is the opening `---`; find the closing fence.
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---") {
      close = i;
      break;
    }
  }
  if (close === -1) {
    // Unclosed fence — treat the whole file as body so we don't lose content.
    return { frontmatter: null, body: cleaned };
  }
  const frontmatter = lines.slice(1, close).join("\n");
  const body = lines.slice(close + 1).join("\n");
  return { frontmatter, body };
}

function parseFrontmatter(raw: string, srcPath: string): SkillFrontmatter {
  let parsed: Record<string, unknown>;
  try {
    parsed = parseYamlSubset(raw) as Record<string, unknown>;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Skill frontmatter parse error in ${srcPath}: ${msg}`);
  }
  const out: SkillFrontmatter = {};
  if (typeof parsed["description"] === "string") {
    out.description = parsed["description"];
  }
  return out;
}

// ─── Filesystem helpers ──────────────────────────────────────────────────────

async function tryRead(p: string): Promise<string | null> {
  try {
    return await readFile(p, "utf8");
  } catch (err: unknown) {
    if (err && typeof err === "object" && "code" in err) {
      const code = (err as { code: string }).code;
      if (code === "ENOENT" || code === "ENOTDIR") return null;
    }
    throw err;
  }
}

async function tryReadDir(p: string): Promise<string[] | null> {
  try {
    return await readdir(p);
  } catch (err: unknown) {
    if (err && typeof err === "object" && "code" in err) {
      const code = (err as { code: string }).code;
      if (code === "ENOENT" || code === "ENOTDIR") return null;
    }
    throw err;
  }
}

async function tryStat(p: string): Promise<import("node:fs").Stats | null> {
  try {
    return await stat(p);
  } catch (err: unknown) {
    if (err && typeof err === "object" && "code" in err) {
      const code = (err as { code: string }).code;
      if (code === "ENOENT" || code === "ENOTDIR") return null;
    }
    throw err;
  }
}

// ─── Active-set resolution ───────────────────────────────────────────────────

/**
 * Return the set of skill names currently active per `config.skills`.
 * Sorted for stable system-prompt rendering (cache-friendly).
 */
export function activeSkillNames(skillsConfig: Record<string, { enabled?: boolean }> | undefined): string[] {
  if (!skillsConfig) return [];
  const out: string[] = [];
  for (const [name, entry] of Object.entries(skillsConfig)) {
    if (entry && entry.enabled === true) out.push(name);
  }
  out.sort();
  return out;
}

/**
 * Load every active skill, in the same order produced by `activeSkillNames`.
 * Missing files yield a warning on stderr and are silently dropped — a
 * config drift (`enabled: true` left behind after a file move) should not
 * brick startup. Use `loadSkill` directly when you want loud failure
 * (the CLI `--skill=NAME` path does that to fail fast on typos).
 */
export async function loadActiveSkills(
  skillsConfig: Record<string, { enabled?: boolean }> | undefined,
  cwd: string = process.cwd(),
): Promise<Skill[]> {
  const names = activeSkillNames(skillsConfig);
  const out: Skill[] = [];
  for (const name of names) {
    try {
      out.push(await loadSkill(name, cwd));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`huko: warning — skill "${name}" enabled but not loadable: ${msg}\n`);
    }
  }
  return out;
}
