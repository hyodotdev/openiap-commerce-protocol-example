import assert from "node:assert/strict";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  SOURCE_FILES,
  extract,
  hashes,
  readRecords,
  sha256,
} from "./checkpoint-tools.mjs";

const target = process.argv[2];
assert(target, "Usage: bun export-docs.mjs <documentation-assets-directory>");
const output = resolve(target);
const source = join(import.meta.dir, "docs/build");
const guide = JSON.parse(readFileSync(join(source, "guide.json"), "utf8"));
const records = readRecords(source);
const selected = guide.map((step) => {
  const record = records.find((record) => record.id === step.id);
  assert(record, `Missing checkpoint: ${step.id}`);
  return record;
});
const last = selected.at(-1);
assert.deepEqual(
  selected.map((record) => record.step),
  guide.map((_, index) => index + 1),
);
assert(
  guide.every(
    (step) => typeof step.label === "string" && step.label.length > 0,
  ),
);
assert.deepEqual(
  Object.fromEntries(
    SOURCE_FILES.sort().map((name) => [
      name,
      sha256(join(import.meta.dir, name)),
    ]),
  ),
  last.sourceHashes,
  "Capture the final source before exporting",
);
const verification = JSON.parse(
  readFileSync(join(source, "verification.json"), "utf8"),
);
for (const record of records) {
  const result = verification.results.find((result) => result.id === record.id);
  assert(
    result?.sourceHashesMatch && result.patchAppliesExactly,
    `Verify ${record.id} before export`,
  );
  assert.equal(
    result.archiveSha256,
    sha256(join(source, record.id, "source.tar.gz")),
  );
  assert.equal(
    result.patchSha256,
    sha256(join(source, record.id, "changes.patch")),
  );
}
const consumerReport = JSON.parse(
  readFileSync(join(source, "consumer-run.json"), "utf8"),
);
for (const [name, digest] of Object.entries(consumerReport.sourceHashes))
  assert.equal(
    digest,
    last.sourceHashes[name],
    "Record the consumer demo again before export",
  );
mkdirSync(output, { recursive: true });
cpSync(join(source, last.id, "source.tar.gz"), join(output, "source.tar.gz"));
for (const record of records)
  cpSync(join(source, record.id), join(output, record.id), { recursive: true });
for (const name of [
  "README.md",
  "REVIEW.md",
  "verification.json",
  "consumer-run.json",
  "01-contract-first-attempt.txt",
])
  cpSync(join(source, name), join(output, name));
const report = {
  recordedAt: last.recordedAt,
  scope: last.scope,
  checks: last.checks,
  standalone: { version: last.packageVersion, passed: last.checks.length },
  milestones: selected.map((record, index) => ({
    ...record.history.at(-1),
    screenshot: `${record.id}/screen.png`,
    build: {
      ...guide[index],
      source: `${record.id}/source.tar.gz`,
      changes: `${record.id}/changes.patch`,
      report: `${record.id}/run.json`,
      ...(record.previous
        ? { previousSource: `${record.previous}/source.tar.gz` }
        : {}),
      passed: record.checks.length,
    },
  })),
};
const temp = mkdtempSync(join(tmpdir(), "commerce-verify-export-"));
try {
  extract(join(source, last.id, "source.tar.gz"), temp);
  assert.deepEqual(hashes(temp), last.sourceHashes);
  cpSync(join(temp, "BUILD.md"), join(output, "build-brief.md"));
  cpSync(join(temp, "INTEGRATE.md"), join(output, "integration-brief.md"));
} finally {
  rmSync(temp, { recursive: true, force: true });
}
writeFileSync(join(output, "run.json"), JSON.stringify(report, null, 2) + "\n");
console.log(
  `Exported ${selected.length} milestones and ${records.length} source revisions to ${output}`,
);
