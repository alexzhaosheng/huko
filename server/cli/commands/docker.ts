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
  const cwd = process.cwd();
  const home = os.homedir();
  const hostHukoDir = path.join(home, ".huko");

  // `-i` keeps stdin open so pipe-friendly use (`cat data | huko docker
  // run -- "..."`) works. `-t` allocates a TTY only when we have one
  // ourselves — needed for chat REPL, harmful in piped contexts (would
  // mangle stdin into TTY mode and kill cat-style pipes).
  const interactive = process.stdin.isTTY === true ? "-it" : "-i";

  const out: string[] = [
    "run",
    "--rm",
    interactive,
    "-v", `${cwd}:${CONTAINER_PROJECT_DIR}`,
    "-v", `${hostHukoDir}:${CONTAINER_HOME_HUKO}`,
    "--workdir", CONTAINER_PROJECT_DIR,
    image,
  ];
  out.push(...innerArgv);
  return out;
}

/** Exposed for tests — pure function, no I/O. */
export function _buildDockerArgsForTest(
  image: string,
  innerArgv: string[],
  opts: { cwd: string; home: string; isTTY: boolean },
): string[] {
  const interactive = opts.isTTY ? "-it" : "-i";
  return [
    "run",
    "--rm",
    interactive,
    "-v", `${opts.cwd}:${CONTAINER_PROJECT_DIR}`,
    "-v", `${path.join(opts.home, ".huko")}:${CONTAINER_HOME_HUKO}`,
    "--workdir", CONTAINER_PROJECT_DIR,
    image,
    ...innerArgv,
  ];
}

/** Exposed for tests — pure function, no I/O. */
export function _resolveImageForTest(explicit: string | undefined, env: NodeJS.ProcessEnv): string {
  if (explicit !== undefined && explicit.length > 0) return explicit;
  const fromEnv = env["HUKO_DOCKER_IMAGE"];
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  return DEFAULT_IMAGE;
}
