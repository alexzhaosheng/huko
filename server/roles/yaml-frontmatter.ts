/**
 * server/roles/yaml-frontmatter.ts
 *
 * Minimal YAML subset parser for role frontmatter. Zero deps.
 *
 * Supports:
 *   key: value                  — string / number / boolean / null
 *   key: "value with: colon"    — double or single-quoted strings
 *   key: [a, b, c]              — inline arrays of scalars
 *   key:                        — nested map (children at exactly +2 spaces)
 *     subkey: value
 *     subkey: [a, b]
 *   # comment                   — full-line and trailing comments
 *
 * Does NOT support:
 *   - Block-style arrays (`- item` on its own line)
 *   - 3+ levels of nesting
 *   - Anchors / aliases / multi-line strings / heredocs
 *   - `---` separators inside the body (caller already split the fence)
 *
 * If the role schema ever outgrows this, swap in `js-yaml` and delete
 * this file. Today we'd rather own ~120 lines than take a dep.
 */
type YamlValue =
  | string
  | number
  | boolean
  | null
  | YamlValue[]
  | { [k: string]: YamlValue };

export function parseYamlSubset(input: string): Record<string, YamlValue> {
  const lines = input.split(/\r?\n/);
  const out: Record<string, YamlValue> = {};
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;
    const stripped = stripComment(line);
    if (stripped.trim() === "") {
      i++;
      continue;
    }

    const indent = leadingSpaces(line);
    if (indent !== 0) {
      throw new Error(
        `Frontmatter parse error: unexpected indent at line ${i + 1}: ${line}`,
      );
    }

    const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(stripped);
    if (!m) {
      throw new Error(
        `Frontmatter parse error: cannot parse line ${i + 1}: ${line}`,
      );
    }

    const key = m[1]!;
    const valuePart = m[2]!.trim();

    if (valuePart === "") {
      // Block: gather indented children.
      const block: Record<string, YamlValue> = {};
      i++;
      while (i < lines.length) {
        const childLine = lines[i]!;
        const childStripped = stripComment(childLine);
        if (childStripped.trim() === "") {
          i++;
          continue;
        }
        const childIndent = leadingSpaces(childLine);
        if (childIndent === 0) break;
        if (childIndent !== 2) {
          throw new Error(
            `Frontmatter parse error: expected 2-space indent at line ${i + 1}: ${childLine}`,
          );
        }
        const cm = /^\s+([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(childStripped);
        if (!cm) {
          throw new Error(
            `Frontmatter parse error: cannot parse nested line ${i + 1}: ${childLine}`,
          );
        }
        const childKey = cm[1]!;
        const childValueStr = cm[2]!.trim();
        if (childValueStr === "") {
          throw new Error(
            `Frontmatter parse error: 3+ levels of nesting not supported at line ${i + 1}`,
          );
        }
        block[childKey] = parseScalar(childValueStr);
        i++;
      }
      out[key] = block;
      continue;
    }

    out[key] = parseScalar(valuePart);
    i++;
  }

  return out;
}

// ─── Internals ───────────────────────────────────────────────────────────────

function stripComment(line: string): string {
  // YAML comment rule: `#` starts a comment only when at line start or
  // preceded by whitespace, AND not inside a quoted string. So
  // `description: with # this is a comment` strips to `description: with`,
  // but `description: a#b` keeps the `#` as part of the bare string.
  let inSingle = false;
  let inDouble = false;
  for (let j = 0; j < line.length; j++) {
    const ch = line[j]!;
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === "#" && !inSingle && !inDouble) {
      const prev = j === 0 ? " " : line[j - 1]!;
      if (prev === " " || prev === "\t") return line.slice(0, j);
    }
  }
  return line;
}

function leadingSpaces(line: string): number {
  let n = 0;
  while (n < line.length && line[n] === " ") n++;
  return n;
}

function parseScalar(raw: string): YamlValue {
  const t = raw.trim();
  if (t === "") return "";
  if (t === "null" || t === "~") return null;
  if (t === "true") return true;
  if (t === "false") return false;

  // Inline array
  if (t.startsWith("[") && t.endsWith("]")) {
    const inner = t.slice(1, -1).trim();
    if (inner === "") return [];
    return splitArrayItems(inner).map((p) => parseScalar(p));
  }

  // Quoted string
  if (
    (t.startsWith('"') && t.endsWith('"') && t.length >= 2) ||
    (t.startsWith("'") && t.endsWith("'") && t.length >= 2)
  ) {
    return t.slice(1, -1);
  }

  // Number
  if (/^-?\d+(\.\d+)?$/.test(t)) {
    const n = Number(t);
    if (!Number.isNaN(n) && Number.isFinite(n)) return n;
  }

  // Bare string
  return t;
}

function splitArrayItems(inner: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let start = 0;
  for (let j = 0; j < inner.length; j++) {
    const ch = inner[j]!;
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (!inSingle && !inDouble) {
      if (ch === "[" || ch === "{") depth++;
      else if (ch === "]" || ch === "}") depth--;
      else if (ch === "," && depth === 0) {
        out.push(inner.slice(start, j).trim());
        start = j + 1;
      }
    }
  }
  if (start < inner.length) {
    const last = inner.slice(start).trim();
    if (last !== "") out.push(last);
  }
  return out;
}
