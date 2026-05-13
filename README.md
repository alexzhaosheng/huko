# huko

> An explicit, scriptable AI agent for the command line.

`huko` is a CLI that turns any LLM into a unix-friendly tool: pipe data in, get the answer out, exit code matches the result. State lives in your project directory (`.huko/`), agent capabilities are layered and inspectable, and the whole thing runs in a Docker sandbox when you want it to.

```bash
# Install
npm install -g @alexzhaosheng/huko

# Configure once (interactive: provider + key + default model)
huko setup

# Use
huko -- "fix the failing test in tests/auth.test.ts"
cat errors.log | huko -- "extract the root cause" > summary.txt
huko --json -- "list open ports as JSON" > ports.json
huko docker run -- "audit dependencies for known CVEs"   # sandboxed
```

---

## Why huko

- **Pipe-friendly.** `cat data | huko -- "instruction"` works the way `grep` and `jq` do — stdin is data, argv is the operation. stdout is the answer; stderr is diagnostics. Pipe-friendly all the way through.
- **Project as context.** State (`sessions`, `keys`, `config`) lives in `<cwd>/.huko/` like `.git`. CD into a repo and huko has its memory; CD out and you're in a different world.
- **Provider-agnostic.** Anthropic / OpenAI / DeepSeek / Zhipu / MiniMax / OpenRouter / Moonshot / your own gateway. Switch with `huko provider current <name>` or `huko model current <id>`.
- **Sandboxable.** `huko docker run -- "..."` runs the agent in a container with your project mounted at `/work`. Filesystem isolation by default; pipes still work.
- **Tool-level safety.** Per-tool `disable` / `deny` / `allow` / `requireConfirm` rules. Disabled tools disappear from the LLM's surface entirely — it can't call what it can't see. Per-project by default; layered with global.
- **Three-layer redaction.** Built-in regex scrubs OpenAI / Anthropic / GitHub / AWS / PEM / JWT shapes from every outbound message; a global vault registers exact strings (`huko vault add github-token`) that never leave the machine; auto-allocated placeholders work BOTH ways — the LLM uses `[REDACTED:foo]` symbolically in tool calls and we expand to the real value before execution.
- **Explicit configuration.** Layered: built-in → `~/.huko/` → `<cwd>/.huko/`. Every value `huko config show` reports its layer of origin.
- **Two modes.** `full` for production-grade agent work (planning, ~13 tools, project context). `lean` for one-shot questions (~85% smaller per-call overhead).

---

## Install

### npm

```bash
npm install -g @alexzhaosheng/huko
huko --help
```

Requires Node.js 24+.

### Docker

```bash
docker pull ghcr.io/alexzhaosheng/huko:latest
huko docker run -- "fix the bug in main.ts"
```

The `huko docker run` wrapper auto-mounts `$PWD` and `~/.huko`, forwards your shell's API-key env vars, and hands the rest of the argv to the inner huko. Full convention in [`docs/docker.md`](docs/docker.md).

---

## Quick start

```bash
# 1. One-time setup — pick provider, supply key, choose default model.
huko setup

# 2. Run something.
huko -- "summarise what changed in this branch since main"

# 3. Talk back and forth.
huko --chat
```

That's the full happy path. Everything else is variations on the same shape.

---

## Patterns

### Pipe data in, get the answer out

```bash
cat errors.log     | huko -- "extract the root cause in one sentence"
git diff           | huko -- "review for risky changes"
ss -tulpn          | huko --json -- "list open ports as JSON" > ports.json
echo "say hi"      | huko                    # stdin alone is the prompt
huko < prompt.txt                            # file redirect works the same
```

When stdin is piped AND argv has a prompt, they combine: stdin is treated as input data, argv as the instruction. Mirrors how `grep`/`jq`/`awk` feel.

### Sessions

```bash
huko sessions list                           # all chats in this project
huko sessions current                        # the active one
huko sessions switch 7                       # rejoin chat #7
huko --new -- "start a fresh thread"         # new session, becomes active
huko --memory -- "one-off, leaves no trace"  # ephemeral, no on-disk state
huko --chat                                  # interactive REPL
```

Short flags for the high-frequency ones: `-n` = `--new`, `-m` = `--memory`, `-c` = `--chat`. (No POSIX bundling — write them separately: `huko -n -m -- "..."`.)

### Output formats

```bash
huko -- "..."           # default text (assistant answer to stdout, diag to stderr)
huko --json -- "..."    # one JSON document at task end
huko --jsonl -- "..."   # streaming events line-delimited
```

### Provider / model / key management

```bash
huko provider list
huko model list
huko keys list                               # shows source layer per ref
huko keys set deepseek sk-...                # writes <cwd>/.huko/keys.json (chmod 600)
huko model current openrouter/anthropic/claude-sonnet-4-6
huko --lean -- "single-shot, minimal overhead"
```

### Docker (sandboxed runs)

```bash
huko docker run -- "audit deps for CVEs"
cat config.yaml | huko docker run -- "is this safe for production?"
huko docker run --image myorg/huko-fork:dev -- "..."   # custom image
```

The container has filesystem isolation (only `$PWD` + `~/.huko` are mounted) but full network egress by default. See [`docs/docker.md`](docs/docker.md) for the precise security model.

### Safety (tool-level controls)

```bash
huko safety tool                              # list every tool + status + rule counts
huko safety disable web_fetch                 # remove from LLM surface entirely
huko safety enable web_fetch                  # put it back
huko safety deny bash 're:^rm -rf'            # block matching calls
huko safety allow bash '^ls '                 # auto-approve matching calls
huko safety require write_file 're:/etc/'    # prompt operator before matching calls
huko safety unset bash 'rm -rf'               # remove a single pattern
huko safety unset bash                        # wipe the whole entry
huko safety list                              # full pattern dump per tool
huko safety check bash command='rm -rf /'     # dry-run a hypothetical call
```

Editing verbs default to **project** (`<cwd>/.huko/config.json`); pass `--global` for `~/.huko/config.json`. `disabled` is stronger than `deny` — the LLM never sees the tool's name or schema, so it can't try to call it.

### Vault (per-string redaction)

```bash
huko vault add github-token                   # hidden prompt for the value
huko vault add prod-db-pw --value 'p@ssw0rd!' # direct (scripting only — leaks to history)
huko vault list                               # names + lengths (NEVER values)
huko vault remove old-token                   # unregister
echo "my password is p@ssw0rd!" | huko vault test   # debug: see what gets redacted
```

Three-layer redaction every outbound message goes through:

1. **Built-in regex** (always on) — known shapes like `sk-...`, `ghp_...`, `AKIA...`, PEM private keys, JWTs.
2. **`safety.redactPatterns`** (project / global config) — your own regex for environment-specific secret shapes.
3. **Vault** (`~/.huko/vault.json`, chmod 600) — exact strings you registered. **Round-trips**: when the LLM emits a tool call referencing a placeholder, huko expands it back to the real value before the tool runs — the LLM never sees raw, but can still USE the secret symbolically.

Storage is global only; project-specific redactions belong in regex (Layer 2). For real isolation use `huko docker run` to sandbox the whole agent.

---

## Configuration

Layered, just like `git config`:

```
built-in defaults  →  ~/.huko/{providers,config,keys}.json  →  <cwd>/.huko/{...}.json
```

Inspect:
```bash
huko info             # everything that's resolved + which layer set what
huko config show      # the runtime config side
```

Edit through the CLI:
```bash
huko config set mode lean --project          # this project only
huko config set mode lean --global           # all projects
huko safety init                             # scaffold per-tool safety rules (project)
huko safety disable web_fetch                # see Safety section above
```

Or just edit the JSON files directly — huko reads them on every run, no caching.

---

## Documentation

| Topic | File |
|---|---|
| CLI surface, argv parsing, all flags | [`docs/modules/cli.md`](docs/modules/cli.md) |
| Architecture overview | [`docs/architecture.md`](docs/architecture.md) |
| Configuration model | [`docs/modules/config.md`](docs/modules/config.md) |
| Per-tool safety policy | run `huko safety init` for the template |
| Docker convention + key resolution | [`docs/docker.md`](docs/docker.md) |
| CI/CD pipeline + release process | [`docs/cicd.md`](docs/cicd.md) |
| Working agreements (for contributors) | [`CLAUDE.md`](CLAUDE.md) |

---

## Development

```bash
git clone https://github.com/alexzhaosheng/huko.git
cd huko
npm install
npm test                  # 549+ tests, cross-platform
npx tsc --noEmit          # strict type check
npm run build:cli         # esbuild bundle → dist/cli.js

npm link                  # install your local checkout as `huko`
```

Or use the unbuilt source directly via tsx:
```bash
npx tsx server/cli/index.ts -- "your prompt"
```

CI runs the same `tsc + test + build` matrix on Linux/macOS/Windows × Node 24 for every PR. The Dockerfile gets a sanity build on every PR too. See [`docs/cicd.md`](docs/cicd.md) for the full pipeline.

---

## Status

`v0.1.0` — first public release. The kernel + CLI are stable enough for daily use; we're still iterating on the management surface (menus, multi-agent flows, daemon mode). Breaking changes will follow SemVer; no `v1.0` until the surface settles.

---

## License

MIT. See [`LICENSE`](LICENSE).
