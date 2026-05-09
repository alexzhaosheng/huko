/**
 * server/cli/commands/model.ts
 *
 * `huko model <verb>` — manage model definitions in the user-global
 * infra DB (`~/.huko/infra.db`).
 *
 * Verbs:
 *   - `list`                 print all models with their providers
 *   - `add <flags>`          create a model linked to an existing provider
 *   - `remove <id>`          delete a model
 *   - `default [<id>]`       show or set the system-default model
 *
 * Each function returns `Promise<number>` (exit code). The single
 * `process.exit()` site lives in `cli/index.ts`.
 *
 * Exit codes:
 *   0  ok    1  internal error    4  provider/model not found
 */

import {
  SqliteInfraPersistence,
  type InfraPersistence,
  type ModelRowJoined,
} from "../../persistence/index.js";
import type { ThinkLevel, ToolCallMode } from "../../core/llm/types.js";

export type OutputFormat = "text" | "jsonl" | "json";

export type ModelListArgs = { format: OutputFormat };

export type ModelAddArgs = {
  /** Either a provider name or its numeric id (as string from CLI). */
  provider: string;
  modelId: string;
  displayName?: string;
  thinkLevel?: ThinkLevel;
  toolCallMode?: ToolCallMode;
  /** When true, also set this model as system default. */
  setDefault?: boolean;
};

export type ModelRemoveArgs = { id: number };

export type ModelDefaultArgs = { id?: number };

// ─── list ────────────────────────────────────────────────────────────────────

export async function modelListCommand(args: ModelListArgs): Promise<number> {
  let infra: InfraPersistence | null = null;
  try {
    infra = new SqliteInfraPersistence();
    const rows = await infra.models.list();
    const defaultId = await infra.config.getDefaultModelId();

    switch (args.format) {
      case "json":
        process.stdout.write(
          JSON.stringify(rows.map((r) => serialise(r, defaultId)), null, 2) + "\n",
        );
        break;
      case "jsonl":
        for (const r of rows) {
          process.stdout.write(JSON.stringify(serialise(r, defaultId)) + "\n");
        }
        break;
      case "text":
      default:
        printTable(rows, defaultId);
        break;
    }
    return 0;
  } catch (err) {
    process.stderr.write(`huko: model list failed: ${describe(err)}\n`);
    return 1;
  } finally {
    closeQuietly(infra);
  }
}

// ─── add ─────────────────────────────────────────────────────────────────────

export async function modelAddCommand(args: ModelAddArgs): Promise<number> {
  let infra: InfraPersistence | null = null;
  try {
    infra = new SqliteInfraPersistence();
    const providers = await infra.providers.list();

    const provider =
      /^\d+$/.test(args.provider)
        ? providers.find((p) => p.id === Number(args.provider))
        : providers.find((p) => p.name === args.provider);

    if (!provider) {
      process.stderr.write(
        `huko: provider not found: ${args.provider}\n` +
          `      run \`huko provider list\` to see available providers\n`,
      );
      return 4;
    }

    const id = await infra.models.create({
      providerId: provider.id,
      modelId: args.modelId,
      displayName: args.displayName ?? args.modelId,
      ...(args.thinkLevel !== undefined ? { defaultThinkLevel: args.thinkLevel } : {}),
      ...(args.toolCallMode !== undefined ? { defaultToolCallMode: args.toolCallMode } : {}),
    });

    let defaultNote = "";
    if (args.setDefault) {
      await infra.config.setDefaultModelId(id);
      defaultNote = "\n      set as system default";
    }

    process.stderr.write(
      `huko: created model ${id} ("${args.displayName ?? args.modelId}" via "${provider.name}")${defaultNote}\n`,
    );
    process.stdout.write(String(id) + "\n");
    return 0;
  } catch (err) {
    process.stderr.write(`huko: model add failed: ${describe(err)}\n`);
    return 1;
  } finally {
    closeQuietly(infra);
  }
}

// ─── remove ──────────────────────────────────────────────────────────────────

export async function modelRemoveCommand(args: ModelRemoveArgs): Promise<number> {
  let infra: InfraPersistence | null = null;
  try {
    infra = new SqliteInfraPersistence();
    const list = await infra.models.list();
    const target = list.find((m) => m.id === args.id);
    if (!target) {
      process.stderr.write(`huko: model not found: ${args.id}\n`);
      return 4;
    }

    await infra.models.delete(args.id);
    process.stderr.write(`huko: removed model ${args.id} ("${target.displayName}")\n`);

    // Clear system default if it pointed here.
    const defaultId = await infra.config.getDefaultModelId();
    if (defaultId === args.id) {
      await infra.config.set("default_model_id", null);
      process.stderr.write(
        `      (system default cleared — set a new one with \`huko model default <id>\`)\n`,
      );
    }
    return 0;
  } catch (err) {
    process.stderr.write(`huko: model remove failed: ${describe(err)}\n`);
    return 1;
  } finally {
    closeQuietly(infra);
  }
}

// ─── default ─────────────────────────────────────────────────────────────────

export async function modelDefaultCommand(args: ModelDefaultArgs): Promise<number> {
  let infra: InfraPersistence | null = null;
  try {
    infra = new SqliteInfraPersistence();

    if (args.id === undefined) {
      // Read mode.
      const id = await infra.config.getDefaultModelId();
      if (id === null) {
        process.stdout.write("(none)\n");
        return 0;
      }
      const list = await infra.models.list();
      const row = list.find((m) => m.id === id);
      if (!row) {
        process.stdout.write(`${id} (no longer in DB)\n`);
        return 0;
      }
      process.stdout.write(`${row.id}  ${row.displayName} (${row.providerName})\n`);
      return 0;
    }

    // Write mode.
    const list = await infra.models.list();
    const row = list.find((m) => m.id === args.id);
    if (!row) {
      process.stderr.write(`huko: model not found: ${args.id}\n`);
      return 4;
    }
    await infra.config.setDefaultModelId(args.id);
    process.stderr.write(
      `huko: system default model -> ${args.id} ("${row.displayName}" via "${row.providerName}")\n`,
    );
    return 0;
  } catch (err) {
    process.stderr.write(`huko: model default failed: ${describe(err)}\n`);
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

function serialise(
  row: ModelRowJoined,
  defaultId: number | null,
): {
  id: number;
  modelId: string;
  displayName: string;
  provider: { id: number; name: string; protocol: string };
  thinkLevel: string;
  toolCallMode: string;
  isDefault: boolean;
  createdAt: string;
} {
  return {
    id: row.id,
    modelId: row.modelId,
    displayName: row.displayName,
    provider: {
      id: row.providerId,
      name: row.providerName,
      protocol: row.providerProtocol,
    },
    thinkLevel: row.defaultThinkLevel,
    toolCallMode: row.defaultToolCallMode,
    isDefault: row.id === defaultId,
    createdAt: new Date(row.createdAt).toISOString(),
  };
}

function printTable(rows: ModelRowJoined[], defaultId: number | null): void {
  if (rows.length === 0) {
    process.stdout.write(
      "(no models)\n  add one with `huko model add --provider=... --model-id=...`\n",
    );
    return;
  }

  const header = ["ID", "DISPLAY", "MODEL ID", "PROVIDER", "THINK", "TOOL", "DEFAULT"];
  const data = rows.map((r) => [
    String(r.id),
    r.displayName,
    r.modelId,
    r.providerName,
    r.defaultThinkLevel,
    r.defaultToolCallMode,
    r.id === defaultId ? "*" : "",
  ]);

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
