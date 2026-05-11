/**
 * tests/tool-execute-content.test.ts
 *
 * Locks the rule for what content goes on a persisted tool_result entry
 * (i.e. what the LLM sees in its conversation history). Regression: an
 * earlier version always synthesized `Error: ${error}` whenever the
 * handler returned a non-null error, discarding the detailed message
 * the handler had explicitly placed in `content`.
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import { selectToolResultContent } from "../server/task/pipeline/tool-execute.js";

describe("selectToolResultContent", () => {
  it("uses the handler's content verbatim on error (preserves detail)", () => {
    const result = "Error: edits[2].find must be a string.";
    const error = "bad edit shape";
    assert.equal(selectToolResultContent(result, error), result);
  });

  it("uses the handler's content on success", () => {
    const result = "1\thello\n2\tworld\n";
    assert.equal(selectToolResultContent(result, null), result);
  });

  it("synthesizes Error: ${error} when result is empty AND error is set", () => {
    assert.equal(selectToolResultContent("", "unexpected_thing"), "Error: unexpected_thing");
  });

  it("returns empty string when both result and error are empty", () => {
    assert.equal(selectToolResultContent("", null), "");
  });

  it("preserves multi-line detail (e.g. read_file errors)", () => {
    const result = "Error: cannot read /home/x.txt: ENOENT, no such file or directory";
    const error = "read failed";
    const out = selectToolResultContent(result, error);
    assert.equal(out, result);
    assert.match(out, /ENOENT/);
    assert.doesNotMatch(out, /^Error: read failed$/);
  });
});
