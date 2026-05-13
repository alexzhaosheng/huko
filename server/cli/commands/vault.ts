/**
 * server/cli/commands/vault.ts
 *
 * `huko vault <verb>` — manage the global password vault that backs
 * Layer 3 of the redaction system. See `server/security/vault.ts`
 * for the storage / format / threat model and `docs/...` for the
 * user-facing semantics.
 *
 * Verbs:
 *   add <name>             prompt for the value (hidden), persist it
 *   add <name> --value <s> direct value via flag (scripting; not
 *                          recommended — leaks to shell history)
 *   remove <name>          remove by name
 *   list                   names + length + addedAt (NEVER values)
 *   test                   debug helper — pipe text in, see redacted out
 *
 * All values must be ≥ 8 chars (enforced by `addVaultEntry`) — short
 * strings cause too many false positives during outbound scrubbing.
 */

import {
  addVaultEntry,
  listVaultEntries,
  loadVault,
  removeVaultEntry,
  vaultPath,
} from "../../security/vault.js";
import { scrubAndRecord } from "../../security/scrubber.js";
import { MemorySessionPersistence } from "../../persistence/memory.js";
import {
  PromptCancelled,
  openPrompter,
} from "./prompts.js";
import { bold, cyan, dim, green, red, yellow } from "../colors.js";

// ─── add ────────────────────────────────────────────────────────────────────

export async function vaultAddCommand(args: {
  name: string;
  /** Direct value, skipping the hidden prompt. Discouraged. */
  inlineValue?: string;
}): Promise<number> {
  let value = args.inlineValue;
  if (value === undefined) {
    const p = openPrompter();
    try {
      value = await p.promptHidden(`Enter value for vault entry "${args.name}" (input hidden)`);
    } catch (err) {
      p.close();
      if (err instanceof PromptCancelled) {
        process.stderr.write("\nhuko vault add: cancelled\n");
        return 130;
      }
      throw err;
    }
    p.close();
  }

  if (!value || value.length === 0) {
    process.stderr.write(red("huko vault add: empty value, aborting\n"));
    return 3;
  }

  try {
    const result = addVaultEntry(args.name, value);
    if (result.kind === "added") {
      process.stderr.write(
        green(`huko: added vault entry "${args.name}" (${value.length} chars) → ${vaultPath()}\n`),
      );
    } else {
      process.stderr.write(
        green(
          `huko: replaced vault entry "${args.name}" ` +
            `(was ${result.previousLength} chars, now ${value.length}) → ${vaultPath()}\n`,
        ),
      );
    }
    return 0;
  } catch (err) {
    process.stderr.write(red(`huko vault add: ${describe(err)}\n`));
    return 3;
  }
}

// ─── remove ─────────────────────────────────────────────────────────────────

export async function vaultRemoveCommand(args: { name: string }): Promise<number> {
  const removed = removeVaultEntry(args.name);
  if (!removed) {
    process.stderr.write(yellow(`huko vault remove: no entry named "${args.name}"; nothing to do\n`));
    return 0;
  }
  process.stderr.write(green(`huko: removed vault entry "${args.name}" from ${vaultPath()}\n`));
  return 0;
}

// ─── list ───────────────────────────────────────────────────────────────────

export async function vaultListCommand(): Promise<number> {
  const entries = listVaultEntries();
  if (entries.length === 0) {
    process.stdout.write(dim(`(no entries — ${vaultPath()} doesn't exist or is empty)\n`));
    process.stdout.write(dim("  add one with: huko vault add <name>\n"));
    return 0;
  }
  process.stdout.write(bold("=== Vault entries ===") + "  " + dim(`(${vaultPath()})`) + "\n");
  const colName = Math.max(...entries.map((e) => e.name.length), 4);
  for (const e of entries) {
    const date = new Date(e.addedAt).toISOString().slice(0, 16).replace("T", " ");
    process.stdout.write(
      `  ${cyan(e.name).padEnd(colName + 9)}  ${String(e.length).padStart(5)} chars   ${dim(date)}\n`,
    );
  }
  process.stdout.write("\n" + dim("Values are never displayed. Use the file directly only if you must.\n"));
  return 0;
}

// ─── test ───────────────────────────────────────────────────────────────────

/**
 * Read text from stdin, run it through the scrubber (vault + Layer 2
 * patterns), and print the redacted version. Uses an in-memory
 * substitution table — doesn't touch any real session DB. Intended
 * for debugging "is my secret being caught?".
 */
export async function vaultTestCommand(): Promise<number> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.length === 0) {
    process.stderr.write(
      yellow("huko vault test: stdin was empty; pipe some text in.\n") +
      dim('       example: echo "my password is xxxxx" | huko vault test\n'),
    );
    return 3;
  }

  // Use a throwaway in-memory persistence so substitutions don't
  // pollute any real session DB. Session id 0 / chat is fine — it's
  // just a key for the in-memory map.
  const persistence = new MemorySessionPersistence();
  const scrubbed = await scrubAndRecord(text, {
    sessionId: 0,
    sessionType: "chat",
    persistence,
  });

  // Show the diff: vault-loaded count, what would be redacted, the
  // scrubbed output.
  const vaultCount = loadVault().length;
  process.stderr.write(
    dim(`(vault has ${vaultCount} ${vaultCount === 1 ? "entry" : "entries"}; ` +
      `Layer 2 built-in patterns always active)\n`),
  );
  process.stdout.write(scrubbed);
  if (!scrubbed.endsWith("\n")) process.stdout.write("\n");
  return 0;
}

// ─── helpers ────────────────────────────────────────────────────────────────

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
