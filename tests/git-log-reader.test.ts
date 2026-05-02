import { test } from "node:test";
import assert from "node:assert/strict";
import { parseGitLog } from "../src/git-log-reader";

test("parses a single line", () => {
  const out = "abc1234567890abc1234567890abc1234567890a\tinitial commit\t2026-04-30T12:00:00+00:00\tAlper";
  const rows = parseGitLog(out);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sha, "abc1234567890abc1234567890abc1234567890a");
  assert.equal(rows[0].subject, "initial commit");
  assert.equal(rows[0].authorName, "Alper");
  assert.equal(rows[0].committedAt, "2026-04-30T12:00:00+00:00");
});

test("parses multiple lines and ignores blank trailing lines", () => {
  const out = [
    "1111111111111111111111111111111111111111\tone\t2026-04-30T12:00:00+00:00\tA",
    "2222222222222222222222222222222222222222\ttwo\t2026-04-30T11:00:00+00:00\tB",
    "",
  ].join("\n");
  const rows = parseGitLog(out);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].subject, "one");
  assert.equal(rows[1].subject, "two");
});

test("handles tabs inside subjects by joining the rest of the line", () => {
  // git log uses %x09 as separator; subjects rarely contain tabs but
  // we should not crash if they do — keep first 3 separators authoritative.
  const out = "3333333333333333333333333333333333333333\tfix:\twith tab\t2026-04-30T10:00:00+00:00\tC";
  const rows = parseGitLog(out);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sha, "3333333333333333333333333333333333333333");
  assert.equal(rows[0].subject, "fix:\twith tab");
  assert.equal(rows[0].committedAt, "2026-04-30T10:00:00+00:00");
  assert.equal(rows[0].authorName, "C");
});

test("returns [] for empty input", () => {
  assert.deepEqual(parseGitLog(""), []);
  assert.deepEqual(parseGitLog("\n\n"), []);
});
