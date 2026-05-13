# Security

> `server/security/` handles API key lookup, redaction, vault substitution, and safety scaffolding.

See [architecture.md](../architecture.md) for cross-module principles.

## Core Rule

Actual secret values must never be stored in the database and must never be sent to the LLM.

## API Key Lookup

Provider rows store `api_key_ref`, not the key value. At runtime, the key resolver checks:

1. `<cwd>/.huko/keys.json`
2. Environment variables
3. `<cwd>/.env`

The first available value wins.

## Vault and Redaction

The security layer protects outbound messages through multiple mechanisms:

- Built-in regex scrubbers for common key shapes such as OpenAI, Anthropic, GitHub, AWS, PEM, and JWT.
- A user vault that stores exact strings and replaces them with stable placeholders.
- Session-time substitution so the LLM can use placeholders symbolically while tools receive the real value only at execution time.
- Path deny rules where configured.

## Placeholder Contract

The LLM may see placeholders such as `[REDACTED:name]`. Tool execution can expand placeholders back to real values only when the value is needed locally and policy allows it.

## File Rules

`keys.json`, local DB files, and state files should be ignored by project `.gitignore` files. The CLI should create a protective `.huko/.gitignore` by default.

## Pitfalls

- Do not store key values in provider rows.
- Do not trust `chmod 600` as a cross-platform security boundary; Windows behaves differently.
- Do not assume the `.env` parser is identical to the `dotenv` package if the project uses a minimal parser.
- Do not add `keys.json` to git. Even if ignore files are removed, safety checks should catch it.
- Do not send vault contents to the LLM for "explanation" or debugging.

## Verification

```bash
npm run check
npm test
```

Redaction tests should cover exact vault strings, regex patterns, placeholder expansion, and outbound scrub behavior.

## See Also

- [persistence.md](./persistence.md)
- [cli.md](./cli.md)
- [audit-2026-05.md](../audit-2026-05.md)
