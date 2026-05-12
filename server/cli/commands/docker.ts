/**
 * server/cli/commands/docker.ts
 *
 * `huko docker run` — execute huko inside a container with the
 * canonical mounts already wired up. This is a THIN wrapper: build the
 * docker argv, spawn it with stdio inherited, forward the exit code.
 * The wrapper does NOT replicate any docker functionality; users who
 * need custom networking, env vars, additional mounts, etc. should
 * fall back to raw `docker run`.
 *
 * Signal handling: SIGINT/SIGTERM on the wrapper propagate to docker
 * (which propagates to the inner huko). Node's child_process.spawn
 * with stdio:"inherit" already does the right thing when the parent
 * receives SIGINT — both processes see it via the same controlling
 * terminal — so we don't install custom forwarding. Exit code mirrors
 * docker's exit code; if docker died from a signal, we re-raise the
 * signal so the shell sees the right $?.
 *
 * Detection: `docker` not on PATH → exit 4 with a clear message. We
 * deliberately don't probe for daemon liveness or pull the image —
 * that's docker's job and its error messages are fine as-is.
 */

import { spawn } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";

import { loadInfraConfig } from "../../config/index.js";
import { envVarNameFor } from "../../security/keys.js";

export type DockerRunArgs = {
  /** Image to run; falls back to HUKO_DOCKER_IMAGE env, then a built-in default. */
  image?: string;
  /**
   * Argv to hand to the inner huko inside the container, verbatim.
   * Includes any forwarded huko flags, the `--` sentinel, and the
   * prompt itself. Empty array is fine — same as `huko` with no args
   * inside the container (drains stdin, or shows usage on TTY).
   */
  innerArgv: string[];
};

/**
 * Default container image.
 *
 * BRIDGE PERIOD (until first tagged release): points at `:edge` —
 * built on every push to main by .github/workflows/edge-image.yml.
 * `:latest` doesn't exist yet, so defaulting to it would 404 every
 * `huko docker run`. Once the release pipeline (docs/cicd.md phase 3)
 * lands and we cut the first `v0.x.0`, switch this back to `:latest`
 * and `:edge` becomes the moving "fresh from main" channel.
 *
 * Override per-call: `--image <name>` or HUKO_DOCKER_IMAGE env.
 */
const DEFAULT_IMAGE = "ghcr.io/alexzhaosheng/huko:edge";

/**
 * Container-side paths. These match the convention documented in
 * docs/docker.md — DON'T change them without updating that doc, since
 * users sometimes write their own `docker run` invocations against the
 * same layout (e.g. inside compose files).
 */
const CONTAINER_PROJECT_DIR = "/work";
const CONTAINER_HOME_HUKO = "/root/.huko";

export async function dockerRunCommand(args: DockerRunArgs): Promise<number> {
  const image = resolveImage(args.image);
  const dockerBin = process.platform === "win32" ? "docker.exe" : "docker";

  const dockerArgs = buildDockerArgs(image, args.innerArgv);

  return await new Promise<number>((resolve) => {
    const child = spawn(dockerBin, dockerArgs, {
      stdio: "inherit",
    });

    child.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        process.stderr.write(
          `huko docker: \`${dockerBin}\` not found in PATH.\n` +
            `             Install Docker (https://docs.docker.com/get-docker/) and try again.\n`,
        );
        resolve(4); // 4 = target not found (matches the existing exit-code table)
        return;
      }
      process.stderr.write(`huko docker: failed to launch docker: ${err.message}\n`);
      resolve(1);
    });

    child.on("exit", (code, signal) => {
      if (signal) {
        // docker died from a signal — re-raise so $? on the shell is
        // 128+signo (the conventional encoding) rather than a clean 0.
        process.kill(process.pid, signal);
        return;
      }
      resolve(code ?? 1);
    });
  });
}

// ─── Internals ──────────────────────────────────────────────────────────────

function resolveImage(explicit: string | undefined): string {
  if (explicit !== undefined && explicit.length > 0) return explicit;
  const fromEnv = process.env["HUKO_DOCKER_IMAGE"];
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  return DEFAULT_IMAGE;
}

function buildDockerArgs(image: string, innerArgv: string[]): string[] {
  return _buildDockerArgsForTest(image, innerArgv, {
    cwd: process.cwd(),
    home: os.homedir(),
    isTTY: process.stdin.isTTY === true,
    forwardedEnvVars: collectKeyEnvVars(),
  });
}

/**
 * Collect API-key env vars to forward into the container.
 *
 * Strategy: load the host's merged providers config, derive the
 * conventional env-var name from each provider's `apiKeyRef` (via the
 * same `envVarNameFor` helper huko itself uses to resolve keys), and
 * filter to vars that are actually set + non-empty in `process.env`.
 *
 * Why this is bounded and safe:
 *   - We only forward vars that providers explicitly DECLARE they
 *     might use — no blanket "anything matching *_API_KEY".
 *   - We pass `-e NAME` (no value), so docker forwards the value from
 *     the current shell env without us touching it. Empty/unset vars
 *     are filtered out so we don't accidentally clear a value the
 *     container would otherwise pick up from mounted keys.json.
 *   - Best-effort: if loadInfraConfig throws (no config yet, broken
 *     JSON, ...) we forward nothing and the container falls back to
 *     mount-based key resolution. Never blocks the launch.
 */
function collectKeyEnvVars(): string[] {
  try {
    const infra = loadInfraConfig({ cwd: process.cwd() });
    const refs = infra.providers.map((p) => p.apiKeyRef);
    return _collectKeyEnvVarsForTest(refs, process.env);
  } catch {
    return [];
  }
}

/** Exposed for tests — pure function, no I/O. */
export function _buildDockerArgsForTest(
  image: string,
  innerArgv: string[],
  opts: { cwd: string; home: string; isTTY: boolean; forwardedEnvVars?: string[] },
): string[] {
  const interactive = opts.isTTY ? "-it" : "-i";
  const envFlags: string[] = [];
  for (const name of opts.forwardedEnvVars ?? []) {
    envFlags.push("-e", name);
  }
  return [
    "run",
    "--rm",
    interactive,
    ...envFlags,
    "-v", `${opts.cwd}:${CONTAINER_PROJECT_DIR}`,
    "-v", `${path.join(opts.home, ".huko")}:${CONTAINER_HOME_HUKO}`,
    "--workdir", CONTAINER_PROJECT_DIR,
    image,
    ...innerArgv,
  ];
}

/**
 * Exposed for tests — pure function, no I/O.
 *
 * Given a list of `apiKeyRef` strings (typically pulled from the
 * merged providers config) and an env snapshot, return the unique
 * env-var names that should be `-e`-forwarded into the container:
 * the conventional `<REF>_API_KEY` shape, intersected with refs that
 * have a non-empty value in `env`.
 */
export function _collectKeyEnvVarsForTest(
  apiKeyRefs: Iterable<string>,
  env: NodeJS.ProcessEnv,
): string[] {
  const names = new Set<string>();
  for (const ref of apiKeyRefs) names.add(envVarNameFor(ref));
  return [...names].filter((name) => {
    const v = env[name];
    return typeof v === "string" && v.length > 0;
  });
}

/** Exposed for tests — pure function, no I/O. */
export function _resolveImageForTest(explicit: string | undefined, env: NodeJS.ProcessEnv): string {
  if (explicit !== undefined && explicit.length > 0) return explicit;
  const fromEnv = env["HUKO_DOCKER_IMAGE"];
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  return DEFAULT_IMAGE;
}
