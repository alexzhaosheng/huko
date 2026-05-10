/**
 * server/task/tools/server/_fuzzy-edit.ts
 *
 * Whitespace-tolerant find-and-replace fallback for the `edit_file`
 * tool. Ported verbatim from WeavesAI's `server/tools/fuzzy-edit.ts`
 * (the user's own open-source project) — its design and edge cases
 * have been validated against many real edit failures.
 *
 * Design principles (unchanged from WeavesAI):
 *   - Exact match is always tried first (zero overhead for the happy path).
 *   - Fuzzy match only activates on exact-match failure (fallback, not default).
 *   - Fuzzy match normalises whitespace (leading indent, trailing spaces,
 *     blank-line differences) but NEVER changes non-whitespace characters.
 *   - When fuzzy match succeeds, the replacement text's indentation is
 *     auto-aligned to the matched block's actual indentation.
 *   - Pure utility module — no I/O, no state, no platform branches.
 */

// ─── Types ───

export type FuzzyMatchResult = {
  found: boolean;
  startIndex: number;
  endIndex: number;
  matchType: "exact" | "fuzzy" | "none";
  matchedText: string;
};

export type FuzzyEditResult = {
  content: string;
  matchType: "exact" | "fuzzy";
};

// ─── Core: Fuzzy Find ───

export function fuzzyFind(haystack: string, needle: string): FuzzyMatchResult {
  // 1. Exact match — always preferred.
  const exactIdx = haystack.indexOf(needle);
  if (exactIdx !== -1) {
    return {
      found: true,
      startIndex: exactIdx,
      endIndex: exactIdx + needle.length,
      matchType: "exact",
      matchedText: needle,
    };
  }

  // 2. Fuzzy match — normalise whitespace and search line-by-line.
  const needleLines = needle.split("\n");
  const haystackLines = haystack.split("\n");

  const normaliseLine = (line: string): string =>
    line.trimEnd().replace(/^[ \t]+/, (ws) => {
      const expanded = ws.replace(/\t/g, "  ");
      return " ".repeat(expanded.length);
    });

  const normalisedNeedle = needleLines.map(normaliseLine);

  // Trim leading/trailing blank lines from the needle so they don't
  // skew the search; we'll re-attach them at the matched site.
  let needleStart = 0;
  let needleEnd = normalisedNeedle.length;
  while (needleStart < needleEnd && normalisedNeedle[needleStart]!.trim() === "") needleStart++;
  while (needleEnd > needleStart && normalisedNeedle[needleEnd - 1]!.trim() === "") needleEnd--;

  const trimmedNeedle = normalisedNeedle.slice(needleStart, needleEnd);
  if (trimmedNeedle.length === 0) {
    return { found: false, startIndex: -1, endIndex: -1, matchType: "none", matchedText: "" };
  }

  const normalisedHaystack = haystackLines.map(normaliseLine);

  for (let i = 0; i <= normalisedHaystack.length - trimmedNeedle.length; i++) {
    let matched = true;
    for (let j = 0; j < trimmedNeedle.length; j++) {
      if (normalisedHaystack[i + j] !== trimmedNeedle[j]) {
        matched = false;
        break;
      }
    }
    if (!matched) continue;

    let matchStartLine = i;
    let matchEndLine = i + trimmedNeedle.length;

    // Re-extend over the leading/trailing blank lines we trimmed off
    // the needle, but only as far as the haystack has matching blanks.
    let leadingBlanks = needleStart;
    while (leadingBlanks > 0 && matchStartLine > 0 && haystackLines[matchStartLine - 1]!.trim() === "") {
      matchStartLine--;
      leadingBlanks--;
    }

    let trailingBlanks = normalisedNeedle.length - needleEnd;
    while (trailingBlanks > 0 && matchEndLine < haystackLines.length && haystackLines[matchEndLine]!.trim() === "") {
      matchEndLine++;
      trailingBlanks--;
    }

    // Convert line indices back to character indices.
    let startCharIdx = 0;
    for (let k = 0; k < matchStartLine; k++) {
      startCharIdx += haystackLines[k]!.length + 1;
    }
    let endCharIdx = startCharIdx;
    for (let k = matchStartLine; k < matchEndLine; k++) {
      endCharIdx += haystackLines[k]!.length + 1;
    }
    if (endCharIdx > haystack.length) endCharIdx = haystack.length;
    if (endCharIdx > 0 && haystack[endCharIdx - 1] === "\n" && !needle.endsWith("\n")) {
      endCharIdx--;
    }

    return {
      found: true,
      startIndex: startCharIdx,
      endIndex: endCharIdx,
      matchType: "fuzzy",
      matchedText: haystack.slice(startCharIdx, endCharIdx),
    };
  }

  return { found: false, startIndex: -1, endIndex: -1, matchType: "none", matchedText: "" };
}

// ─── Core: Fuzzy Edit ───

export function fuzzyEdit(
  content: string,
  find: string,
  replace: string,
): FuzzyEditResult | null {
  const match = fuzzyFind(content, find);
  if (!match.found) return null;

  let finalReplace = replace;
  if (match.matchType === "fuzzy") {
    finalReplace = alignIndentation(find, match.matchedText, replace);
  }

  const newContent =
    content.slice(0, match.startIndex) +
    finalReplace +
    content.slice(match.endIndex);

  return {
    content: newContent,
    matchType: match.matchType as FuzzyEditResult["matchType"],
  };
}

// ─── Indentation Alignment ───

function alignIndentation(find: string, matched: string, replace: string): string {
  const findLines = find.split("\n");
  const matchedLines = matched.split("\n");

  const findIndent = getFirstNonEmptyIndent(findLines);
  const matchedIndent = getFirstNonEmptyIndent(matchedLines);
  if (findIndent === null || matchedIndent === null) return replace;

  const delta = matchedIndent - findIndent;
  if (delta === 0) return replace;

  return replace
    .split("\n")
    .map((line) => {
      if (line.trim() === "") return line;
      const currentIndent = line.match(/^[ \t]*/)?.[0] ?? "";
      const currentSpaces = currentIndent.replace(/\t/g, "  ").length;
      const newSpaces = Math.max(0, currentSpaces + delta);
      return " ".repeat(newSpaces) + line.trimStart();
    })
    .join("\n");
}

function getFirstNonEmptyIndent(lines: string[]): number | null {
  for (const line of lines) {
    if (line.trim() === "") continue;
    const indent = line.match(/^[ \t]*/)?.[0] ?? "";
    return indent.replace(/\t/g, "  ").length;
  }
  return null;
}
