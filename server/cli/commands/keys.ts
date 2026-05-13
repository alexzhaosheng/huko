/**
 * server/cli/commands/keys.ts
 *
 * `huko keys <verb>` — manage API-key resolution for the cwd.
 *
 * Verbs:
 *   - `set <ref>`                  prompt hidden for value, write to
 *                                   <cwd>/.huko/keys.json (chmod 600)
 *   - `set <ref> --value <secret>` direct value via flag (scripting;
 *                                   not recommended — leaks to shell
 *                                   history / /proc/<pid>/cmdline)
 *   - `unset <ref>`                remove from <cwd>/.huko/keys.json
 *   - `list`                       show every provider ref + which layer
 *                                   currently resolves it (NOT the value)
 *
 * Each command returns `Promise<number>` (exit code). The single
 * `process.exit()` site lives in `cli/index.ts`.
 *
 * The actual key value is only printed by the user themselves (via
 * `cat .huko/keys.json` etc.) — these commands never write secrets to
 * stdout/stderr. The list view tells you whether a ref is resolvable
 * and which layer wins.
 *
 * Resolution order (highest first, set in `server/security/keys.ts`):
 *   1. <cwd>/.huko/keys.json
 *   2. ~/.huko/keys.json
 *   3. process.env.<REF_UPPER>_API_KEY
 *   4. <cwd>/.env
 *
 * Exit codes:
 *   0  ok    1  internal error    3  user error    4  not found (unset)
 */

import { loadInfraConfig } from "../../config/index.js";
import {
  describeKeySource,
  envVarNameFor,
  listProjectKeyRefs,
  setProjectKey,
  unsetProjectKey,
} from "../../security/keys.js";
import { PromptCancelled, openPrompter } from "./prompts.js";

export type KeysSetArgs = {
  ref: string;
  /** Direct value, skipping the hidden prompt. Discouraged. */
  inlineValue?: string;
};
export type KeysUnsetArgs = { ref: string };

// ─── set ─────────────────────────────────────────────────────────────────────

export async function keysSetCommand(args: KeysSetArgs): Promise<number> {
  const cwd = process.cwd();
  let value = args.inlineValue;
  if (value === undefined) {
    const p = openPrompter();
    try {
      value = await p.promptHidden(
        `Enter API key for "${args.ref}" (input hidden)`,
      );
    } catch (err) {
      p.close();
      if (err instanceof PromptCancelled) {
        process.stderr.write("\nhuko keys set: cancelled\n");
        return 130;
      }
      throw err;
    }
    p.close();
  }

  if (!value || value.length === 0) {
    process.stderr.write("huko keys set: empty value, aborting\n");
    return 3;
  }

  try {
    setProjectKey(args.ref, value, { cwd });
    process.stderr.write(
      `huko: wrote key "${args.ref}" to ${cwd}/.huko/keys.json (chmod 600)\n`,
    );
    return 0;
  } catch (err) {
    process.stderr.write(`huko: keys set failed: ${describe(err)}\n`);
    return 1;
  }
}

// ─── unset ───────────────────────────────────────────────────────────────────

export async function keysUnsetCommand(args: KeysUnsetArgs): Promise<number> {
  const cwd = process.cwd();
  try {
    const removed = unsetProjectKey(args.ref, { cwd });
    if (!removed) {
      process.stderr.write(
        `huko: key "${args.ref}" not present in ${cwd}/.huko/keys.json\n`,
      );
      return 4;
    }
    process.stderr.write(`huko: removed key "${args.ref}" from project keys.json\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`huko: keys unset failed: ${describe(err)}\n`);
    return 1;
  }
}

// ─── list ────────────────────────────────────────────────────────────────────

/**
 * Walk every provider ref the infra DB knows about, plus any extra refs
 * present in `<cwd>/.huko/keys.json` that don't appear in the DB. For
 * each, report the layer the resolver would pick. NEVER prints the
 * actual key — only the layer name and the matching env-var name.
 */
export async function keysListCommand(): Promise<number> {
  const cwd = process.cwd();
  try {
    const cfg = loadInfraConfig({ cwd });
    const providers = cfg.providers;
    const projectRefs = listProjectKeyRefs({ cwd });

    const seen = new Set<string>();
    type Row = { ref: string; layer: string; envName: string; usedBy: string };
    const out: Row[] = [];

    // First, refs that providers reference. Always shown, even when unset.
    for (const p of providers) {
      if (seen.has(p.apiKeyRef)) continue;
      seen.add(p.apiKeyRef);
      const src = describeKeySource(p.apiKeyRef, { cwd });
      const usingProviders = providers
        .filter((q) => q.apiKeyRef === p.apiKeyRef)
        .map((q) => q.name)
        .join(", ");
      out.push({
        ref: p.apiKeyRef,
        layer: src.layer,
        envName: src.envName,
        usedBy: usingProviders,
      });
    }

    // Then, project-keys.json refs no provider references — the user
    // pre-staged them. Useful diagnostic ("did I typo a ref?").
    for (const ref of projectRefs) {
      if (seen.has(ref)) continue;
      seen.add(ref);
      const src = describeKeySource(ref, { cwd });
      out.push({
        ref,
        layer: src.layer,
        envName: src.envName,
        usedBy: "(no provider)",
      });
    }

    if (out.length === 0) {
      process.stdout.write(
        "(no providers configured — add one with `huko provider add ...`)\n",
      );
      return 0;
    }

    const header = ["REF", "RESOLVES FROM", "ENV VAR", "USED BY"];
    const data = out.map((r) => [r.ref, r.layer, r.envName, r.usedBy]);
    const widths = header.map((h, i) =>
      Math.max(h.length, ...data.map((row) => row[i]!.length)),
    );

    const sep = "  ";
    const lines: string[] = [];
    lines.push(header.map((h, i) => pad(h, widths[i]!)).join(sep));
    lines.push(widths.map((w) => "─".repeat(w)).join(sep));
    for (const row of data) {
      lines.push(row.map((cell, i) => pad(cell, widths[i]!)).join(sep));
    }
    process.stdout.write(lines.join("\n") + "\n");
    if (out.some((r) => r.layer === "unset")) {
      process.stderr.write(
        "\nResolution order (highest wins):\n" +
          "  1. <cwd>/.huko/keys.json   (huko keys set <ref>)\n" +
          "  2. ~/.huko/keys.json       (set by `huko setup`; same shape)\n" +
          "  3. process.env             (export <REF_UPPER>_API_KEY=...)\n" +
          "  4. <cwd>/.env              (<REF_UPPER>_API_KEY=...)\n",
      );
    }
    return 0;
  } catch (err) {
    process.stderr.write(`huko: keys list failed: ${describe(err)}\n`);
    return 1;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

// Re-export so cli/index.ts can pick it up if it wants to surface the
// env-var convention alongside command help.
export { envVarNameFor };
