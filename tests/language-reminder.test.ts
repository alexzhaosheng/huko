/**
 * tests/language-reminder.test.ts
 *
 * Pure unit tests for the language drift module.
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
  classifyWorkingLanguage,
  countCjk,
  countLatin,
  detectWorkingLanguage,
  maybeBuildLanguageDriftReminder,
} from "../server/task/language-reminder.js";
import type { LLMMessage } from "../server/core/llm/types.js";

// ─── classify ────────────────────────────────────────────────────────────────

describe("classifyWorkingLanguage", () => {
  it("returns cjk for Chinese / Japanese / Korean labels", () => {
    assert.equal(classifyWorkingLanguage("中文"), "cjk");
    assert.equal(classifyWorkingLanguage("Chinese"), "cjk");
    assert.equal(classifyWorkingLanguage("zh-CN"), "cjk");
    assert.equal(classifyWorkingLanguage("Japanese"), "cjk");
    assert.equal(classifyWorkingLanguage("한국어"), "cjk");
  });

  it("returns latin for English / French / German / Spanish", () => {
    assert.equal(classifyWorkingLanguage("English"), "latin");
    assert.equal(classifyWorkingLanguage("en"), "latin");
    assert.equal(classifyWorkingLanguage("French"), "latin");
    assert.equal(classifyWorkingLanguage("Spanish"), "latin");
  });

  it("returns unknown for null / empty / unrecognised", () => {
    assert.equal(classifyWorkingLanguage(null), "unknown");
    assert.equal(classifyWorkingLanguage(""), "unknown");
    assert.equal(classifyWorkingLanguage("Klingon"), "unknown");
  });
});

// ─── counters ────────────────────────────────────────────────────────────────

describe("countCjk / countLatin", () => {
  it("counts only CJK code points in countCjk", () => {
    assert.equal(countCjk("hello world"), 0);
    assert.equal(countCjk("你好"), 2);
    assert.equal(countCjk("hello 世界"), 2);
    assert.equal(countCjk("カタカナ"), 4);
  });

  it("counts only A-Z a-z in countLatin", () => {
    assert.equal(countLatin("你好"), 0);
    assert.equal(countLatin("hello"), 5);
    assert.equal(countLatin("hello 世界"), 5);
    assert.equal(countLatin("12345"), 0);
  });
});

// ─── detect ──────────────────────────────────────────────────────────────────

describe("detectWorkingLanguage", () => {
  it("picks 中文 for CJK-dominant text", () => {
    assert.equal(detectWorkingLanguage("帮我看一下这段代码有什么问题"), "中文");
  });

  it("picks English for Latin-dominant text", () => {
    assert.equal(
      detectWorkingLanguage("can you take a look at this code"),
      "English",
    );
  });

  it("returns null for too-short input", () => {
    assert.equal(detectWorkingLanguage("hi"), null);
    assert.equal(detectWorkingLanguage("   "), null);
  });

  it("returns null for ambiguous mixes (equal counts)", () => {
    assert.equal(detectWorkingLanguage("ab 你好"), null);
  });
});

// ─── drift detection ────────────────────────────────────────────────────────

function userMsg(content: string): LLMMessage {
  return { role: "user", content };
}
function assistantMsg(content: string): LLMMessage {
  return { role: "assistant", content };
}
function systemMsg(content: string): LLMMessage {
  return { role: "system", content };
}

// Both fixtures are sized well above FOREIGN_THRESHOLD (500 chars of
// the foreign script class) so the drift trigger fires reliably.
const LATIN_LONG = "the quick brown fox jumps over the lazy dog ".repeat(30);
const CJK_LONG = "中文测试漂移检测的语料文本足够长以触发阈值".repeat(40);

describe("maybeBuildLanguageDriftReminder", () => {
  it("returns null when working language is null", () => {
    const r = maybeBuildLanguageDriftReminder(
      [userMsg(LATIN_LONG), assistantMsg(LATIN_LONG)],
      null,
    );
    assert.equal(r, null);
  });

  it("returns null when there is no foreign drift", () => {
    const r = maybeBuildLanguageDriftReminder(
      [userMsg("你好，请帮我"), assistantMsg("好的，没问题")],
      "中文",
    );
    assert.equal(r, null);
  });

  it("fires for CJK working language drowned in Latin", () => {
    const r = maybeBuildLanguageDriftReminder(
      [userMsg("你好"), assistantMsg(LATIN_LONG)],
      "中文",
    );
    assert.ok(r, "expected drift reminder");
    assert.equal(r!.role, "user");
    assert.match(String(r!.content), /language_drift/);
    assert.match(String(r!.content), /中文/);
    assert.match(String(r!.content), /English/);
  });

  it("fires for Latin working language drowned in CJK", () => {
    const r = maybeBuildLanguageDriftReminder(
      [userMsg("hello"), assistantMsg(CJK_LONG)],
      "English",
    );
    assert.ok(r);
    assert.match(String(r!.content), /CJK/);
    assert.match(String(r!.content), /English/);
  });

  it("respects the ratio gate (mixed scripts don't fire)", () => {
    const mixed = userMsg(LATIN_LONG + CJK_LONG);
    const r = maybeBuildLanguageDriftReminder([mixed], "中文");
    assert.equal(r, null);
  });

  it("ignores system messages while scanning", () => {
    const r = maybeBuildLanguageDriftReminder(
      [
        systemMsg(LATIN_LONG),
        userMsg("你好"),
        assistantMsg("好的"),
      ],
      "中文",
    );
    assert.equal(r, null);
  });
});
