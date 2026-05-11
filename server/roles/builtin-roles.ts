/**
 * server/roles/builtin-roles.ts
 *
 * Built-in capability best-practices, bundled as markdown blobs inside
 * TypeScript. After the 2026-05 redesign, these are NOT persona
 * overlays — they exist solely to be injected as expert checklists into
 * the tool_result when a `plan` phase is tagged with the matching
 * capability name.
 *
 * Each entry is `<capability_name> -> raw .md content`. `loadRole(name)`
 * consults this map as the lowest-precedence layer after project /
 * user filesystem overrides; `best-practices.ts` then extracts the
 * `## Best Practices` section for injection.
 *
 * Universal agent conduct (be terse, match request weight, use tools
 * instead of guessing, surface uncertainty, deliver via message.result)
 * lives in the base system prompt's `<principles>` block, NOT here.
 * Only capability-specific guidance belongs in this file.
 *
 * To add a built-in capability: push another entry below.
 */

/** Map of capability name -> raw markdown body (incl. frontmatter). */
export const BUILTIN_ROLES: Record<string, string> = {

  // ─── coding ─────────────────────────────────────────────────────────────────

  coding: `---
description: Best-practices for source code reading, editing, and review.
---

## Best Practices

- MUST read affected files end-to-end before patching; do NOT edit from incomplete context
- MUST follow existing conventions (naming, indentation, imports, comment density) — never impose your own style
- MUST run the project's type-check / tests after a substantive edit; "compiles in my head" is not done
- MUST make the smallest change that satisfies the requirement; do NOT refactor unrelated code while fixing a bug
- For shell commands, prefer non-interactive flags (\`-y\`, \`--yes\`, \`--no-input\`) and cap long-running commands with timeouts
- When summarising work done, bullet-list the changes file-by-file
- When reporting a problem, state what failed, where, and what you tried — before proposing fixes
- MUST NOT delete files, drop tables, force-push, or rewrite git history without explicit user approval
`,

  // ─── writing ────────────────────────────────────────────────────────────────

  writing: `---
description: Best-practices for technical documents and longer-form prose.
---

## Best Practices

- MUST save substantial pieces (more than ~10 lines) to a markdown file via \`write_file\`, NOT inline in chat
- MUST deliver final output as a file path via \`message(type=result)\`
- MUST default to GitHub-flavoured Markdown; use pipe tables, never raw HTML tables
- For technical writing: prose paragraphs as the body, NOT bullet-list-only output
- MUST hold to user-specified length, tone, audience, and format constraints
- MUST cite sources for non-common-knowledge factual claims; inline numeric citations with a reference list
- MUST NOT use emoji in professional documents
- For creative writing: maintain consistent tone, point of view, and tense across the piece
- Show, don't tell — concrete sensory details, dialogue, and action over abstract description
- Deliver one file per piece; do NOT split a single deliverable across multiple attachments
`,

  // ─── research ───────────────────────────────────────────────────────────────

  research: `---
description: Best-practices for multi-source investigation and synthesis.
---

## Best Practices

- MUST gather information from multiple independent sources; NEVER rely solely on internal knowledge
- MUST read multiple URLs from search results (use \`web_fetch\`) for cross-validation
- MUST save key findings to a notes file as you research — externalise before context compresses
- MUST include inline citations with source URLs for every factual claim in the final output
- MUST present balanced perspectives when the topic is debated or contested
- MUST clearly distinguish between established facts, expert opinions, and your own analysis
- For non-English topics, MUST include at least one English search variant for broader coverage
- MUST end the final document with a \`## Sources\` list, one annotated URL per entry
- MUST NOT fabricate quotes, URLs, dates, or statistics — if a source doesn't exist, say so
`,

  // ─── analysis ───────────────────────────────────────────────────────────────

  analysis: `---
description: Best-practices for tabular data analysis, summarisation, and visualisations.
---

## Best Practices

- MUST save analysis code to files (\`write_file\`) before running via \`bash\`; do NOT run multi-line analysis inline
- MUST validate data quality first — null counts, duplicate counts, types, outliers — before drawing conclusions
- MUST use pandas for tabular work; matplotlib / seaborn / plotly for visualisations
- MUST save plots as PNG files and attach the file paths in the result message
- MUST include clear axis labels, titles, and legends on every chart
- MUST quantify findings with sample size and units — never assert a trend without the numbers behind it
- MUST surface a "Limitations" paragraph: what the data doesn't cover, what assumptions you made
- MUST NOT fabricate data, statistics, or correlations — if the dataset is insufficient, state that as the finding
- For multi-file datasets, write one script that reads them all rather than chaining bash invocations
`,
};
