import assert from "node:assert/strict";
import { test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import {
  createPatch,
  nextAttempt,
  sanitize,
  readRecords,
} from "./checkpoint-tools.mjs";

test("patches preserve path-like source text across additions, changes, and deletions", () => {
  const temp = mkdtempSync(join(tmpdir(), "commerce-patch-test-"));
  try {
    const before = join(temp, "before"),
      after = join(temp, "after");
    mkdirSync(before);
    mkdirSync(after);
    writeFileSync(
      join(after, "capture.mjs"),
      "const paths = ['a/before/', 'b/after/'];\n",
    );
    assert.match(
      createPatch(before, after),
      /\+const paths = \['a\/before\/', 'b\/after\/'\];/,
    );
    writeFileSync(join(before, "capture.mjs"), "old\n");
    writeFileSync(join(before, "removed.md"), "remove\n");
    assert.match(createPatch(before, after), /deleted file mode/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("failed attempts get new numbers and private paths are redacted", () => {
  const temp = mkdtempSync(join(tmpdir(), "commerce-capture-test-"));
  try {
    writeFileSync(join(temp, "failure-1.txt"), "first failure");
    assert.equal(nextAttempt(temp), 2);
    writeFileSync(join(temp, "failure-2.txt"), "second failure");
    assert.equal(nextAttempt(temp), 3);
    const output = sanitize(
      `${homedir()}/.npm/_logs/debug.log ${import.meta.dir}/capture.mjs ${temp}/source.mjs`,
    );
    assert(!output.includes(homedir()));
    assert(!output.includes(import.meta.dir));
    assert(!output.includes(temp));
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("unfinished captures do not hide completed records", () => {
  const temp = mkdtempSync(join(tmpdir(), "commerce-capture-test-"));
  try {
    mkdirSync(join(temp, "01-complete"));
    writeFileSync(
      join(temp, "01-complete/run.json"),
      JSON.stringify({ id: "01-complete" }),
    );
    mkdirSync(join(temp, "02-failed"));
    writeFileSync(join(temp, "02-failed/failure-1.txt"), "Browser unavailable");
    assert.deepEqual(readRecords(temp), [{ id: "01-complete" }]);
    writeFileSync(
      join(temp, "02-failed/run.json"),
      JSON.stringify({ id: "02-failed" }),
    );
    assert.equal(readRecords(temp).length, 2);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
