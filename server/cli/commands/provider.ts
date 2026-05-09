/**
 * server/cli/commands/provider.ts
 *
 * `huko provider <verb>` — manage LLM providers in the user-global
 * infra DB (`~/.huko/infra.db`).
 *
 * Verbs:
 *   - `list`                 print all providers
 *   - `add <flags>`          create a provider
 *   - `remove <id|name>`     delete a provider (cascades to its models)
 *
 * Each function returns `Promise<number>` (exit code). The CLI's single
 * `process.exit()` lives in `cli/index.ts`.
 *
 * Exit codes:
 *   0  ok    1  internal error    4  not found (remove)
 */

import {
  SqliteInfraPersistence,
  type InfraPersistence,
  type ProviderRow,
} from "../../persistence/index.js";
import type { Protocol } from "../../core/llm/types.js";
import { describeKeySource } from "../../security/keys.js";

export type OutputFormat = "text" | "jsonl" | "json";

export type ProviderListArgs = { format: OutputFormat };

export type ProviderAddArgs = {
  name: string;
  protocol: Protocol;
  baseUrl: string;
  apiKeyRef: string;
  defaultHeaders?: Record<string, string>;
};

export type ProviderRemoveArgs = { idOrName: string };

// ─── list ────────────────────────────────────────────────────────────────────

export async function providerListCommand(args: ProviderListArgs): Promise<number> {
  let infra: InfraPersistence | null = null;
  try {
    infra = new SqliteInfraPersistence();
    const rows = await infra.providers.list();

    switch (args.format) {
      case "json":
        process.stdout.write(JSON.stringify(rows.map(serialise), null, 2) + "\n");
        break;
      case "jsonl":
        for (const r of rows) process.stdout.write(JSON.stringify(serialise(r)) + "\n");
        break;
      case "text":
      default:
        printTable(rows);
        break;
    }
    return 0;
  } catch (err) {
    process.stderr.write(`huko: provider list failed: ${describe(err)}\n`);
    return 1;
  } finally {
    closeQuietly(infra);
  }
}

// ─── add ─────────────────────────────────────────────────────────────────────

export async function providerAddCommand(args: ProviderAddArgs): Promise<number> {
  let infra: InfraPersistence | null = null;
  try {
    infra = new SqliteInfraPersistence();

    const id = await infra.providers.create({
      name: args.name,
      protocol: args.protocol,
      baseUrl: args.baseUrl,
      apiKeyRef: args.apiKeyRef,
      ...(args.defaultHeaders !== undefined ? { defaultHeaders: args.defaultHeaders } : {}),
    });

    const src = describeKeySource(args.apiKeyRef);
    const layerNote =
      src.layer === "unset"
        ? `WARNING: api key ref "${args.apiKeyRef}" is NOT yet resolvable. ` +
          `Set ${src.envName} in env, run \`huko keys set ${args.apiKeyRef} <value>\`, ` +
          `or add it to <cwd>/.env.`
        : `key ref "${args.apiKeyRef}" resolves from: ${src.layer}`;

    process.stderr.write(
      `huko: created provider ${id} ("${args.name}", ${args.protocol})\n` +
        `      ${layerNote}\n`,
    );
    process.stdout.write(String(id) + "\n");
    return 0;
  } catch (err) {
    process.stderr.write(`huko: provider add failed: ${describe(err)}\n`);
    return 1;
  } finally {
    closeQuietly(infra);
  }
}

// ─── remove ──────────────────────────────────────────────────────────────────

export async function providerRemoveCommand(args: ProviderRemoveArgs): Promise<number> {
  let infra: InfraPersistence | null = null;
  try {
    infra = new SqliteInfraPersistence();
    const all = await infra.providers.list();

    const target =
      /^\d+$/.test(args.idOrName)
        ? all.find((p) => p.id === Number(args.idOrName))
        : all.find((p) => p.name === args.idOrName);

    if (!target) {
      process.stderr.write(`huko: provider not found: ${args.idOrName}\n`);
      return 4;
    }

    await infra.providers.delete(target.id);
    process.stderr.write(`huko: removed provider ${target.id} ("${target.name}")\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`huko: provider remove failed: ${describe(err)}\n`);
    return 1;
  } finally {
    closeQuietly(infra);
  }
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

function serialise(row: ProviderRow): {
  id: number;
  name: string;
  protocol: string;
  baseUrl: string;
  apiKeyRef: string;
  defaultHeaders: Record<string, string> | null;
  createdAt: string;
} {
  return {
    id: row.id,
    name: row.name,
    protocol: row.protocol,
    baseUrl: row.baseUrl,
    apiKeyRef: row.apiKeyRef,
    defaultHeaders: row.defaultHeaders,
    createdAt: new Date(row.createdAt).toISOString(),
  };
}

function printTable(rows: ProviderRow[]): void {
  if (rows.length === 0) {
    process.stdout.write("(no providers)\n");
    return;
  }

  const header = ["ID", "NAME", "PROTOCOL", "BASE URL", "KEY REF", "KEY"];
  const data = rows.map((r) => {
    const src = describeKeySource(r.apiKeyRef);
    return [
      String(r.id),
      r.name,
      r.protocol,
      r.baseUrl,
      r.apiKeyRef,
      src.layer === "unset" ? "(unset)" : src.layer,
    ];
  });

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
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}
