import assert from "node:assert/strict";
import { test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import {
  createPatch,
  extract,
  hashes,
  nextAttempt,
  run,
  sanitize,
  readRecords,
} from "./checkpoint-tools.mjs";

test("archive extraction excludes macOS metadata and preserves source hashes", () => {
  const temp = mkdtempSync(join(tmpdir(), "commerce-capture-test-"));
  try {
    const source = join(temp, "source");
    mkdirSync(source);
    writeFileSync(join(source, "README.md"), "Source content\n");
    const expected = hashes(source);
    const metadata = Buffer.alloc(70);
    metadata.writeUInt32BE(0x00051607, 0);
    metadata.writeUInt32BE(0x00020000, 4);
    metadata.writeUInt16BE(1, 24);
    metadata.writeUInt32BE(9, 26);
    metadata.writeUInt32BE(38, 30);
    metadata.writeUInt32BE(32, 34);
    writeFileSync(join(source, "._README.md"), metadata);
    const archive = join(temp, "source.tar.gz");
    run("env", [
      "COPYFILE_DISABLE=1",
      "tar",
      "-czf",
      archive,
      "-C",
      source,
      "._README.md",
      "README.md",
    ]);
    const target = join(temp, "extracted");
    extract(archive, target);
    assert.deepEqual(hashes(target), expected);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

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

test("checkpoint replay follows predecessors instead of directory name order", () => {
  const temp = mkdtempSync(join(tmpdir(), "commerce-capture-test-"));
  const records = [
    { id: "07-reviewed", previous: "01-start" },
    { id: "07-interoperable", previous: "07-reviewed" },
    { id: "01-start" },
  ];
  try {
    for (const record of records) {
      mkdirSync(join(temp, record.id));
      writeFileSync(join(temp, record.id, "run.json"), JSON.stringify(record));
    }
    assert.deepEqual(
      readRecords(temp).map((record) => record.id),
      ["01-start", "07-reviewed", "07-interoperable"],
    );
    writeFileSync(
      join(temp, "01-start/run.json"),
      JSON.stringify({ id: "01-start", previous: "07-interoperable" }),
    );
    assert.throws(() => readRecords(temp), /Checkpoint cycle/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
