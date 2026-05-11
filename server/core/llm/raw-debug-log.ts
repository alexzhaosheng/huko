/**
 * server/core/llm/raw-debug-log.ts
 *
 * Raw HTTP-level debug log for LLM provider calls.
 *
 * Distinct from `huko debug llm-log`, which RECONSTRUCTS a reader-
 * friendly HTML report from SQLite after the fact. This module captures
 * the EXACT bytes that hit the wire — the JSON body POSTed to the
 * provider and the response body (or the full SSE event stream for
 * streaming responses) — so you can diff protocol-level behavior, header
 * issues, cache behavior, etc.
 *
 * Activation (off by default — zero overhead when env var is unset):
 *
 *   HUKO_DEBUG_RAW_LLM=1            → write to <cwd>/huko_llm_raw.jsonl
 *   HUKO_DEBUG_RAW_LLM=<path>       → write to <path> (absolute or relative)
 *   (unset / "" / "0" / "false")    → no-op
 *
 * Format: JSON-lines (one object per line). Each LLM call produces two
 * records sharing a `callId`:
 *
 *   { ts, dir: "request",  callId, url, method, headers, body }
 *   { ts, dir: "response", callId, status, statusText, durationMs,
 *     headers, body? | rawSSE?, error? }
 *
 * Redacted request headers (case-insensitive, replaced with
 * "***REDACTED***"): authorization, x-api-key, api-key, anthropic-api-key.
 * The provider api key never reaches the log.
 *
 * Logging failures are swallowed — they must NEVER break the LLM call.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import * as path from "node:path";

const ENV_VAR = "HUKO_DEBUG_RAW_LLM";
const DEFAULT_FILENAME = "huko_llm_raw.jsonl";

// ─── Public types ────────────────────────────────────────────────────────────

export type RequestRecord = {
  callId: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
};

export type ResponseRecord = {
  callId: string;
  status: number;
  statusText: string;
  durationMs: number;
  headers: Record<string, string>;
  /** Set for streaming responses; the verbatim SSE text we received. */
  rawSSE?: string;
  /** Set for non-streaming responses; the parsed body (or raw text on parse-fail). */
  body?: unknown;
  /** Set when fetch threw or the HTTP status indicated an error. */
  error?: string;
};

export type RawDebugLog = {
  logRequest(rec: RequestRecord): void;
  logResponse(rec: ResponseRecord): void;
};

// ─── Singleton accessor ──────────────────────────────────────────────────────

const NOOP: RawDebugLog = {
  logRequest() {},
  logResponse() {},
};

let cached: RawDebugLog | null = null;

export function getRawDebugLog(): RawDebugLog {
  if (cached !== null) return cached;
  cached = build();
  return cached;
}

/** For tests: reset the cached logger so the next get re-reads env. */
export function _resetRawDebugLogForTests(): void {
  cached = null;
}

function build(): RawDebugLog {
  const raw = process.env[ENV_VAR];
  if (!isTruthy(raw)) return NOOP;

  // "1" / "true" → default path; anything else → treat as user-supplied path.
  const usesDefaultPath = raw === "1" || raw!.toLowerCase() === "true";
  const filePath = usesDefaultPath
    ? path.join(process.cwd(), DEFAULT_FILENAME)
    : raw!;

  try {
    mkdirSync(path.dirname(filePath), { recursive: true });
  } catch {
    /* best effort — appendFileSync below will surface a real error if it can't write */
  }

  // Notice on stderr so the user knows the log is active (and where it goes).
  process.stderr.write(
    `huko: HUKO_DEBUG_RAW_LLM is on — raw LLM calls → ${filePath}\n`,
  );

  return {
    logRequest(rec) {
      writeLine(filePath, {
        ts: new Date().toISOString(),
        dir: "request",
        ...rec,
        headers: redactRequestHeaders(rec.headers),
      });
    },
    logResponse(rec) {
      writeLine(filePath, {
        ts: new Date().toISOString(),
        dir: "response",
        ...rec,
      });
    },
  };
}

// ─── Call-id generator ───────────────────────────────────────────────────────

let counter = 0;
const processTag = Date.now().toString(36);

/**
 * Return a short identifier unique within this process. Pairs the
 * "request" and "response" records for one LLM call in the log.
 */
export function nextCallId(): string {
  return `${processTag}-${(++counter).toString(36)}`;
}

// ─── Internals ───────────────────────────────────────────────────────────────

function isTruthy(v: string | undefined): boolean {
  if (v === undefined || v === "") return false;
  const lc = v.toLowerCase();
  if (lc === "0" || lc === "false" || lc === "off" || lc === "no") return false;
  return true;
}

const REDACT_HEADER_NAMES = new Set([
  "authorization",
  "x-api-key",
  "api-key",
  "anthropic-api-key",
]);

function redactRequestHeaders(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    out[k] = REDACT_HEADER_NAMES.has(k.toLowerCase()) ? "***REDACTED***" : v;
  }
  return out;
}

function writeLine(filePath: string, obj: unknown): void {
  try {
    appendFileSync(filePath, JSON.stringify(obj) + "\n", "utf8");
  } catch {
    /* Logging failure must never break the LLM call. Drop silently. */
  }
}
