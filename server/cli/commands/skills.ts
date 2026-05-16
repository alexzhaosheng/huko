/**
 * server/cli/commands/skills.ts
 *
 * `huko skills list` — discovery for operator-authored skills. Walks
 * project + global layers, prints each available skill with its source,
 * whether the resolved config currently has it `enabled: true`, and
 * the frontmatter description (truncated).
 *
 * Authoring / activation lives outside this command:
 *   - drop a markdown file at ~/.huko/skills/<name>.md (or .../<name>/SKILL.md)
 *   - turn it on via `huko config set skills.<name>.enabled true` (persist)
 *     or `--skill=<name>` (one-shot)
 */

import { listAvailableSkills, type Skill } from "../../skills/index.js";
import { getConfig } from "../../config/index.js";
import { bold, cyan, dim, green } from "../colors.js";

export type SkillsListArgs = {
  /** Output format; only `text` for now. Reserved for future jsonl/json. */
  format?: "text";
};

export async function skillsListCommand(_args: SkillsListArgs = {}): Promise<number> {
  const cwd = process.cwd();
  const skills = await listAvailableSkills(cwd);
  const activeMap = getConfig().skills ?? {};

  if (skills.length === 0) {
    process.stdout.write(
      dim("(no skills discovered) — drop markdown files in <cwd>/.huko/skills/ or ~/.huko/skills/") + "\n",
    );
    return 0;
  }

  const rows = skills.map((s) => ({
    skill: s,
    active: activeMap[s.name]?.enabled === true,
  }));

  // Column widths sized to the rendered content (sans ANSI).
  const headers = ["NAME", "SOURCE", "ACTIVE", "DESCRIPTION"];
  const raw: string[][] = rows.map((r) => [
    r.skill.name,
    r.skill.source,
    r.active ? "yes" : "no",
    truncate(r.skill.frontmatter.description ?? "", 60),
  ]);
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...raw.map((row) => row[i]!.length)),
  );
  const sep = "  ";

  const styledRows: string[][] = rows.map((r, idx) => {
    const row = raw[idx]!;
    return [
      cyan(row[0]!),
      dim(row[1]!),
      r.active ? green(row[2]!) : dim(row[2]!),
      row[3]!,
    ];
  });

  const lines: string[] = [];
  lines.push(headers.map((h, i) => bold(pad(h, widths[i]!))).join(sep));
  lines.push(dim(widths.map((w) => "─".repeat(w)).join(sep)));
  for (let i = 0; i < styledRows.length; i++) {
    const cells = styledRows[i]!;
    const rawRow = raw[i]!;
    lines.push(
      cells
        .map((cell, j) => padToVisibleWidth(cell, rawRow[j]!.length, widths[j]!))
        .join(sep),
    );
  }
  process.stdout.write(lines.join("\n") + "\n");
  return 0;
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

/**
 * Pad a cell that already contains ANSI escapes to the same VISIBLE
 * width its plain-text source would occupy. `visibleLen` is the unstyled
 * length; `target` is the column width.
 */
function padToVisibleWidth(styled: string, visibleLen: number, target: number): string {
  if (visibleLen >= target) return styled;
  return styled + " ".repeat(target - visibleLen);
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

// Re-export the Skill type so dispatch can type-check without
// transitively importing from server/skills directly.
export type { Skill };
