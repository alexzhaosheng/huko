/**
 * server/security/builtin-redact-patterns.ts
 *
 * The built-in regex pack used by Layer 2 of the redaction system —
 * patterns that match the well-known shapes of API keys / tokens /
 * private-key blobs that should never reach an LLM provider.
 *
 * Selection criteria (kept narrow to keep false positives near zero):
 *   - Vendor-specific prefixes that are unmistakable (`sk-...`, `ghp_...`)
 *   - Standard cryptographic envelopes (`-----BEGIN PRIVATE KEY-----`)
 *   - Fixed-shape tokens with high entropy
 *
 * Skipped on purpose:
 *   - Generic "looks like base64" or "32 hex chars" — far too noisy.
 *     Internal-format secrets should go in the vault (Layer 3).
 *   - Bearer tokens (`Bearer xxx`) — too generic; users can add via
 *     `safety.redactPatterns` if their workflow needs it.
 *
 * Each entry's `name` becomes part of the placeholder
 * (`[REDACTED:openai-key]`) so the LLM gets a hint about what got
 * removed without seeing the value.
 *
 * Adding a pattern:
 *   - Verify the regex matches at least one real-world example.
 *   - Verify it does NOT match plausibly-occurring non-secret strings
 *     (e.g. checksums, hashes, UUIDs).
 *   - Use lazy quantifiers + character classes that actually bound
 *     the secret length — unbounded `.+` will swallow whole sentences.
 */

export type RedactPattern = {
  /** Stable identifier; appears in placeholders as `[REDACTED:<name>]`. */
  name: string;
  /** ECMAScript regex (string form for portability + JSON-config use). */
  pattern: string;
};

export const BUILTIN_REDACT_PATTERNS: ReadonlyArray<RedactPattern> = [
  // OpenAI: `sk-` then ~48 chars of base62. The 2024-2025 longer
  // user/project keys (`sk-proj-...`, `sk-svcacct-...`) match too.
  { name: "openai-key", pattern: "sk-[A-Za-z0-9_\\-]{20,}" },

  // Anthropic: `sk-ant-...` followed by ~80 chars. The `sk-ant-`
  // prefix is unique enough that the openai-key pattern above won't
  // catch it without the dedicated entry first (alternation order
  // doesn't matter much because compiled-regex engines pick the first
  // that matches at a position, but the longest-match-on-vault rule
  // is enforced separately).
  { name: "anthropic-key", pattern: "sk-ant-[A-Za-z0-9_\\-]{20,}" },

  // GitHub personal-access tokens: `ghp_`, `gho_`, `ghu_`, `ghs_`,
  // `ghr_` followed by exactly 36 base62 chars.
  { name: "github-token", pattern: "gh[poushr]_[A-Za-z0-9]{36}" },

  // GitHub fine-grained PATs: `github_pat_` + base62 + `_` + base62.
  // The `_` in the middle is load-bearing.
  { name: "github-pat", pattern: "github_pat_[A-Za-z0-9]{22}_[A-Za-z0-9]{59}" },

  // AWS access key id — 20-char prefixed identifier. Secret-key bodies
  // get the next pattern.
  { name: "aws-access-key-id", pattern: "AKIA[0-9A-Z]{16}" },

  // AWS secret access key in `aws_secret_access_key = ...` config
  // sections OR after `aws_secret`-ish context. The bare 40-char
  // base64 string is unfortunately too generic on its own; we anchor
  // to context to avoid false positives.
  {
    name: "aws-secret-with-context",
    pattern: "aws[_-]?secret[_-]?access[_-]?key[\"'\\s:=]+[A-Za-z0-9/+=]{40}",
  },

  // Google API keys (`AIza...` then ~35 chars).
  { name: "google-api-key", pattern: "AIza[A-Za-z0-9_\\-]{35}" },

  // Slack tokens — bot, user, app variants share `xox[bpars]-`.
  {
    name: "slack-token",
    pattern: "xox[baprs]-[A-Za-z0-9\\-]{10,}",
  },

  // PEM private keys — match the whole envelope including body. The
  // `[\s\S]` group bounded by the END marker handles multi-line PEM
  // blobs cleanly. Keys this big in chat are almost always a secret
  // (no benign reason to paste a PEM into a prompt).
  {
    name: "private-key-pem",
    pattern:
      "-----BEGIN [A-Z ]*PRIVATE KEY-----[\\s\\S]+?-----END [A-Z ]*PRIVATE KEY-----",
  },

  // JWTs: 3 base64url segments separated by `.`. JWT bodies are not
  // strictly secret (often the whole point is they're inspectable),
  // but the SIGNED form embedded in code or logs typically grants
  // access — treat as secret.
  {
    name: "jwt",
    pattern: "eyJ[A-Za-z0-9_\\-]{10,}\\.[A-Za-z0-9_\\-]{10,}\\.[A-Za-z0-9_\\-]{10,}",
  },
];
