/**
 * server/cli/dispatch/docker.ts
 *
 * `huko docker <verb>` — argv parser + handoff to commands/docker.
 *
 * v1 ships ONE verb: `run`. The wrapper exists to spare the operator
 * from typing the canonical `docker run -v $PWD:/work -v ~/.huko:/root/.huko
 * --workdir /work <image> ...` mount boilerplate every time. It is NOT
 * a docker abstraction layer — anything beyond the convention falls back
 * to raw `docker run`.
 *
 * Parser shape (intentionally tiny):
 *   - `--image <name>` / `--image=<name>` selects the container image.
 *   - `HUKO_DOCKER_IMAGE` env var is the secondary fallback.
 *   - Otherwise: a built-in default in commands/docker.ts.
 *   - Everything else (other flags, the `--` sentinel, the prompt
 *     itself) is passed VERBATIM to the inner huko inside the
 *     container. We don't re-validate huko's own argv here — that's
 *     dispatch/run.ts's job inside the container.
 */

import { dockerRunCommand, type DockerRunArgs } from "../commands/docker.js";
import { usage as baseUsage } from "./shared.js";
import { renderDockerHelp } from "./help.js";

function usage(code: number = 3): never {
  return baseUsage(code, renderDockerHelp);
}

export type DockerParseResult =
  | { kind: "ok"; args: DockerRunArgs }
  | { kind: "help" }
  | { kind: "error"; message: string };

export function parseDockerRun(rest: string[]): DockerParseResult {
  let image: string | undefined;
  let i = 0;
  while (i < rest.length) {
    const arg = rest[i]!;

    // Wrapper-level help short-circuits before we hand off any argv.
    if (arg === "-h" || arg === "--help") return { kind: "help" };

    // `--` is for the inner huko — stop touching argv.
    if (arg === "--") break;

    if (arg === "--image") {
      const next = rest[i + 1];
      if (next === undefined) {
        return { kind: "error", message: "huko docker run: --image requires a value\n" };
      }
      image = next;
      i += 2;
      continue;
    }
    if (arg.startsWith("--image=")) {
      image = arg.slice("--image=".length);
      i++;
      continue;
    }

    // Anything else is for the inner huko. Stop wrapper-level parsing.
    break;
  }

  const innerArgv = rest.slice(i);
  return {
    kind: "ok",
    args: {
      ...(image !== undefined ? { image } : {}),
      innerArgv,
    },
  };
}

export async function dispatchDocker(rest: string[]): Promise<number> {
  if (rest.length === 0) {
    process.stderr.write(
      "huko docker: missing verb (try `huko docker run -- <prompt>`)\n",
    );
    usage();
  }

  const verb = rest[0]!;
  const verbArgs = rest.slice(1);

  if (verb === "-h" || verb === "--help") {
    printDockerHelp();
    return 0;
  }

  if (verb !== "run") {
    process.stderr.write(`huko docker: unknown verb: ${verb} (only \`run\` is supported)\n`);
    usage();
  }

  const parsed = parseDockerRun(verbArgs);
  if (parsed.kind === "help") {
    printDockerHelp();
    return 0;
  }
  if (parsed.kind === "error") {
    process.stderr.write(parsed.message);
    return 3;
  }

  return await dockerRunCommand(parsed.args);
}

function printDockerHelp(): void {
  process.stdout.write(
    "huko docker run [--image <name>] [<huko-flags>...] [-- <prompt>]\n" +
      "\n" +
      "  Run huko inside a container. Mounts your cwd at /work and your\n" +
      "  global config at /root/.huko, then invokes huko with the rest of\n" +
      "  the argv. The inner huko's contract is identical to a host run —\n" +
      "  same flags, same `--` sentinel, same pipe-friendly stdin.\n" +
      "\n" +
      "Wrapper flags:\n" +
      "  --image <name>     Container image (default: HUKO_DOCKER_IMAGE env\n" +
      "                     or the published default). Override per call.\n" +
      "\n" +
      "Examples:\n" +
      "  huko docker run -- fix the bug in main.ts\n" +
      "  cat errors.log | huko docker run -- extract the root cause\n" +
      "  huko docker run --lean -- what's eating memory\n" +
      "  huko docker run --image myorg/huko-fork:dev -- explain this code\n" +
      "\n" +
      "Mounts (added automatically):\n" +
      "  $PWD       → /work        (project: .huko/, source files, etc.)\n" +
      "  ~/.huko    → /root/.huko  (global infra config: providers/keys)\n" +
      "\n" +
      "Keys: two paths — both work without extra flags.\n" +
      "  - keys.json    : resolved through the mounted ~/.huko/keys.json\n" +
      "  - env vars     : auto-forwarded for every provider in your config\n" +
      "                   (we derive the names from each provider's\n" +
      "                    apiKeyRef and pass `-e <NAME>` for those that\n" +
      "                    are set + non-empty in your shell)\n" +
      "\n" +
      "See docs/docker.md for the full convention + the v1 limits.\n",
  );
}
