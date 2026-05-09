/**
 * server/cli/commands/keys.ts
 *
 * `huko keys <verb>` — manage API-key resolution for the cwd.
 *
 * Verbs:
 *   - `set <ref> <value>`    write to <cwd>/.huko/keys.json (chmod 600)
 *   - `unset <ref>`          remove from <cwd>/.huko/keys.json
 *   - `list`                 show every provider ref + which layer
 *                            currently resolves it (NOT the value)
 *
 * The actual key value is only printed by the user themselves (via
 * `cat .huko/keys.json` etc.) — these commands never write secrets to
 * stdout/stderr. The list view tells you whether a ref is resolvable
 * and which layer wins; spelling out the value would defeat the
 * "DB doesn't hold secrets" model.
 *
 * Resolution order (highest first, set in `server/security/keys.ts`):
 *   1. <cwd>/.huko/keys.json
 *   2. process.env.<REF_UPPER>_API_KEY
 *   3. <cwd>/.env
 *
 * Exit codes:
 *   0  ok    1  internal error    3  usage    4  not found (unset)
 */

import {
  SqliteInfraPersistence,
  type InfraPersistence,
} from "../../persistence/index.js";
import {
  describeKeySource,
  envVarNameFor,
  listProjectKeyRefs,
  setProjectKey,
  unsetProjectKey,
} from "../../security/keys.js";

export type KeysSetArgs = { ref: string; value: string };
export type KeysUnsetArgs = { ref: string };

// ─── set ─────────────────────────────────────────────────────────────────────

export async function keysSetCommand(args: KeysSetArgs): Promise<void> {
  const cwd = process.cwd();
  let exitCode = 0;
  try {
    setProjectKey(args.ref, args.value, { cwd });
    process.stderr.write(
      `huko: wrote key "${args.ref}" to ${cwd}/.huko/keys.json (chmod 600)\n`,
    );
  } catch (err) {
    process.stderr.write(`huko: keys set failed: ${describe(err)}\n`);
    exitCode = 1;
  }
  process.exit(exitCode);
}

// ─── unset ───────────────────────────────────────────────────────────────────

export async function keysUnsetCommand(args: KeysUnsetArgs): Promise<void> {
  const cwd = process.cwd();
  let exitCode = 0;
  try {
    const removed = unsetProjectKey(args.ref, { cwd });
    if (!removed) {
      process.stderr.write(
        `huko: key "${args.ref}" not present in ${cwd}/.huko/keys.json\n`,
      );
      exitCode = 4;
      return;
    }
    process.stderr.write(`huko: removed key "${args.ref}" from project keys.json\n`);
  } catch (err) {
    process.stderr.write(`huko: keys unset failed: ${describe(err)}\n`);
    exitCode = 1;
  }
  process.exit(exitCode);
}

// ─── list ────────────────────────────────────────────────────────────────────

/**
 * Walk every provider ref the infra DB knows about, plus any extra refs
 * present in `<cwd>/.huko/keys.json` that don't appear in the DB. For
 * each, report the layer the resolver would pick. NEVER prints the
 * actual key — only the layer name and the matching env-var name.
 */
export async function keysListCommand(): Promise<void> {
  const cwd = process.cwd();
  let infra: InfraPersistence | null = null;
  let exitCode = 0;
  try {
    infra = new SqliteInfraPersistence();
    const providers = await infra.providers.list();
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
      return;
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
          "  1. <cwd>/.huko/keys.json   (huko keys set <ref> <value>)\n" +
          "  2. process.env             (export <REF_UPPER>_API_KEY=...)\n" +
          "  3. <cwd>/.env              (<REF_UPPER>_API_KEY=...)\n",
      );
    }
  } catch (err) {
    process.stderr.write(`huko: keys list failed: ${describe(err)}\n`);
    exitCode = 1;
  } finally {
    closeQuietly(infra);
  }
  process.exit(exitCode);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function closeQuietly(p: InfraPersistence | null): void {
  if (!p) return;
  try {
    void p.close();
  } catch {
    /* already closed */
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

// Re-export so `cli/index.ts` typo-detection sees it (otherwise tsc says
// "envVarNameFor declared but never read"; we want the ref to keep the
// security module aware that the CLI surface depends on the convention).
export { envVarNameFor };
