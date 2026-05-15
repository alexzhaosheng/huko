# huko

> A project-scoped AI agent for the command line — end-to-end task planning, tool use, and code-reading built in.

`huko` is not a prompt utility. Give it a *goal* — *"find why the /api/users endpoint started returning 500"*, *"add Google OAuth following the existing auth patterns"*, *"audit deps for known CVEs"* — and the agent drives the loop: planning next steps, reading your project's code, running shell, calling tools, deciding when the work is actually done. Multiple turns happen inside one invocation, automatically.

State (`sessions`, agent history, `keys`) lives in your project's `.huko/` like `.git`; optional Docker sandbox; per-tool safety policy; multi-provider.

```bash
# Install
npm install -g @alexzhaosheng/huko

# Configure once (interactive: provider + key + default model)
huko setup

# Use
huko -- "the /api/users endpoint is returning 500 — read the handler, follow the imports, find the root cause"
huko -- "add Google OAuth to the login flow, follow the existing auth patterns in src/auth/"
cat logs/recent.log | huko -- "are these errors caused by my recent commits? check git history and tell me which commit"
huko docker run -- "audit dependencies for unmaintained packages and known CVEs"   # sandboxed
```

---

## Why huko

- **Agent loop, not prompt+reply.** Give huko a goal and the model drives — reads your code, runs shell, plans next steps, calls tools, decides when it's done. "Fix this bug" instead of "tell me about this bug". Multi-turn happens inside one invocation, automatically; the framework manages context-window compaction, orphan recovery, and the task lifecycle so you don't have to wire any of it.
- **Project as context.** State (`sessions`, `keys`, `config`) lives in `<cwd>/.huko/` like `.git`. CD into a repo and huko has its memory; CD out and you're in a different world. The agent reads files relative to that cwd, edits within it, and never reaches into a sibling project unless you point it there.
- **Provider-agnostic.** Anthropic / OpenAI / DeepSeek / Zhipu / MiniMax / OpenRouter / Moonshot / your own gateway. Switch with `huko provider current <name>` or `huko model current <id>`.
- **Sandboxable.** `huko docker run -- "..."` runs the agent in a container with your project mounted at `/work`. Filesystem isolation by default; pipes still work.
- **Tool-level safety.** Per-tool `disable` / `deny` / `allow` / `requireConfirm` rules. Disabled tools disappear from the LLM's surface entirely — it can't call what it can't see. Per-project by default; layered with global.
- **Three-layer redaction.** Built-in regex scrubs OpenAI / Anthropic / GitHub / AWS / PEM / JWT shapes from every outbound message; a global vault registers exact strings (`huko vault add github-token`) that never leave the machine; auto-allocated placeholders work BOTH ways — the LLM uses `[REDACTED:foo]` symbolically in tool calls and we expand to the real value before execution.
- **Explicit configuration.** Layered: built-in → `~/.huko/` → `<cwd>/.huko/`. Every value `huko config show` reports its layer of origin.
- **Two modes.** `full` for production-grade agent work (planning, ~13 tools, project context). `lean` for one-shot questions (~85% smaller per-call overhead — the loop still runs, just with one tool and a minimal system prompt).
- **Pipes work, when you want them.** `cat data | huko -- "..."` combines: stdin is data, argv is the instruction. Good for ad-hoc workflows where the agent should ingest pipe content as its starting input — but pipe-friendliness is a convenience here, not the product.

---

## Install

### npm

```bash
npm install -g @alexzhaosheng/huko
huko --version   # confirm install — output includes commit + build date
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
cat logs/recent.log | huko -- "are these errors caused by my recent commits? check git and find culprits"
git diff            | huko -- "review for risky changes — read the affected files for context if needed"
ss -tulpn           | huko --json -- "list open ports as JSON" > ports.json
echo "say hi"       | huko                    # stdin alone is the prompt (lean-style usage)
huko < prompt.txt                             # file redirect works the same
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

`--no-markdown` (`--no-md`) skips terminal markdown rendering — useful when the LLM output contains literal `*` or `|` that the renderer would misinterpret (shell globs, regex patterns).

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
huko keys set deepseek                       # hidden prompt → writes <cwd>/.huko/keys.json (chmod 600)
huko model current anthropic/claude-sonnet-4-6
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

## Browser Control

An opt-in feature that lets the agent operate your real Chrome browser through a lightweight extension. All cookies, logins, and sessions are live — the agent sees and interacts with exactly what you see.

### Quick start

```bash
# 1. Load the extension (one-time setup)
#    Open chrome://extensions, enable "Developer mode",
#    click "Load unpacked" and select the extensions/chrome/ directory.

# 2. Enable browser-control in chat mode
huko --chat --enable=browser-control
```

The extension icon shows connection status: red = disconnected, green = connected.

### How it works

When browser-control is enabled in chat mode, huko starts a local WebSocket server (default port 19222). The Chrome extension connects to this server and executes commands in the user's real browsing environment. When chat mode exits, the server stops and the extension disconnects.

### Configuration

Browser-control parameters live under `tools.browser` in huko's layered config. Inspect or change them with `huko config`:

| Parameter | Default | Description |
|---|---|---|
| `tools.browser.wsPort` | `19222` | WebSocket port for the Chrome extension to connect to |
| `tools.browser.defaultTimeoutMs` | `30000` | Per-action timeout in milliseconds |
| `tools.browser.maxScreenshotBytes` | `5242880` | Maximum screenshot image size in bytes (5 MiB) |

```bash
# Change the port for this project (e.g. port conflict)
huko config set tools.browser.wsPort 19224 --project

# Increase screenshot size limit
huko config set tools.browser.maxScreenshotBytes 10485760 --project

# Inspect current values
huko config show
```

### Limitations

- **Chat mode only.** One-shot runs (`huko -- prompt`) never start sidecars — browser commands will fail with a clear "server not running" error.
- **Single client.** Only one Chrome extension can connect at a time.
- **Local only.** The WebSocket server binds to `127.0.0.1` — no remote browser control.

### Actions

The `browser` tool surfaces these actions to the LLM:

- `navigate` — open a URL in a new tab, return visible page text
- `click` — click the first element matching a CSS selector
- `type` — type text into an input matching a CSS selector
- `scroll` — scroll the active page (up / down / top / bottom)
- `get_text` — return visible text content of the active page
- `get_html` — return full HTML source of the active page
- `screenshot` — capture a PNG screenshot
- `wait` — wait for a selector to appear or a plain timeout
- `list_pages` — list all open tabs (URL + title)
- `switch_page` — switch the active tab by index

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

## Local LLMs

huko speaks OpenAI-compatible HTTP, so any local server that does — **Ollama**, **LM Studio**, **vLLM**, **llama.cpp's `llama-server`**, **LocalAI**, **text-generation-webui** — registers the same way as a hosted provider. Below uses Ollama; the others differ only in `--base-url`.

```bash
# 1. Start the local server + pull a model.
ollama serve &
ollama pull qwen2.5-coder:7b

# 2. Register a key reference. Most local servers ignore the value but
#    expect SOME string in the Authorization header — pick any placeholder.
huko keys set ollama          # interactive (hidden prompt) — type 'EMPTY' or anything

# 3. Register the provider. Protocol is `openai` (= OpenAI-compatible API).
huko provider add \
  --name=ollama \
  --protocol=openai \
  --base-url=http://127.0.0.1:11434/v1 \
  --api-key-ref=ollama

# 4. Register the model under that provider; make it current.
huko model add \
  --provider=ollama \
  --model-id=qwen2.5-coder:7b \
  --context-window=32768 \
  --tool-call-mode=native \
  --current

# 5. Use it.
huko -- "read main.ts and explain the architecture"
```

**Notes:**

- `--context-window=` is required for local models — huko sizes compaction thresholds against it. Grab the right number from the model card or `ollama show <model>` (look for `context length`).
- `--tool-call-mode=native` works when the model + server both implement OpenAI function calling (Qwen 2.5, Llama 3.1, DeepSeek family, recent Ollama). If you see empty / ignored tool calls in responses, switch to `--tool-call-mode=xml` — huko will encode tool calls inside the prompt and parse them from the model's text reply. Slower and a bit less reliable, but works with any model that can follow instructions.
- Other servers' default ports: **LM Studio** `http://127.0.0.1:1234/v1`, **vLLM** `http://127.0.0.1:8000/v1`, **llama.cpp `llama-server`** `http://127.0.0.1:8080/v1`. All keep `--protocol=openai`.
- Custom headers (internal gateway, corporate proxy, etc.) — `--header=X-Foo=bar` on `provider add`, repeatable.
- Project-scoped registration: pass `--project` on `provider add` / `model add` to write to `<cwd>/.huko/providers.json` instead of the global `~/.huko/providers.json`. Useful when a single project pins to a specific local model the rest of your machine doesn't use.

Small models (7B-and-below) typically struggle to keep a multi-step agent loop coherent — they hallucinate file paths, forget which tool they just called, or repeat themselves. **Lean mode** (`huko --lean -- "..."`) is the right pairing: minimal system prompt, just `bash` as the tool, far less for the model to juggle. For the full agent surface, you'll generally want a 32B+ model or a hosted frontier model.

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
npm test                  # full suite, cross-platform (Linux / macOS / Windows × Node 24)
npx tsc --noEmit          # strict type check
npm run build:cli         # esbuild bundle → dist/cli.js (embeds commit + date)

npm link                  # install your local checkout as `huko`
```

Or use the unbuilt source directly via tsx:
```bash
npx tsx server/cli/index.ts -- "your prompt"
```

CI runs the same `tsc + test + build` matrix on Linux/macOS/Windows × Node 24 for every PR. The Dockerfile gets a sanity build on every PR too. See [`docs/cicd.md`](docs/cicd.md) for the full pipeline.

---

## To be implemented

Sketches of the next surface, in rough priority order. None of these are committed scope or timeline — the list exists to signal direction, and so the kernel design stays compatible with them.

- **Skills.** Pre-defined, slash-invoked specialised agents — `/code-review`, `/release-notes`, `/triage`. Each ships with its own system-prompt fragment + tool subset + capability hints; the user can layer them onto any conversation without retyping setup.
- **Daemon mode.** A long-lived background process owns one or more sessions; multiple CLI invocations / IDE plugins / web UI consumers all talk to it. Solves "warm tool state across calls", multi-client coordination, and idle compaction.
- **Remote CLI UI.** `huko --host=user@remote-box -- "..."` — your local terminal driving a daemon running on a remote machine, so the work happens close to the project (file system, network, secrets) and you don't ship gigabytes of repo over your laptop tether.
- **Web UI.** Browser front-end for the daemon — for cases where a long context, side-by-side diff, image attachments, or non-terminal users need more than what a CLI gives. Same kernel underneath.
- **More tools.** Expanding the tool surface — language-server integrations (rename, type-aware refactor), git-operation safety (branch / stash / cherry-pick gated), structured browsing (sitemap-aware crawl, login-required pages), database query introspection.

Want any of these sooner? Open an issue / discussion — priority follows demand.

---

## License

MIT. See [`LICENSE`](LICENSE).
