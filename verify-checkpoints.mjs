import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  extract,
  hashes,
  readRecords,
  run,
  sha256,
} from "./checkpoint-tools.mjs";

const source = resolve(process.argv[2] ?? join(import.meta.dir, "docs/build"));
const temp = mkdtempSync(join(tmpdir(), "commerce-verify-"));
const records = readRecords(source);
const results = [];
try {
  const applied = join(temp, "applied");
  mkdirSync(applied);
  for (const record of records) {
    const directory = join(source, record.id);
    const archive = join(directory, "source.tar.gz");
    const consumer = join(temp, record.id);
    extract(archive, consumer);
    assert.deepEqual(
      hashes(consumer),
      record.sourceHashes,
      `${record.id}: archive hashes`,
    );
    const patch = join(directory, "changes.patch");
    if (readFileSync(patch, "utf8")) run("git", ["apply", patch], applied);
    assert.deepEqual(
      hashes(applied),
      record.sourceHashes,
      `${record.id}: patch chain from empty`,
    );
    const commands = [
      run(
        "npm",
        ["ci", "--ignore-scripts", "--no-audit", "--no-fund"],
        consumer,
      ),
      run("npm", ["test"], consumer),
    ];
    if (
      JSON.parse(readFileSync(join(consumer, "package.json"), "utf8")).scripts[
        "test:tooling"
      ]
    )
      commands.push(run("npm", ["run", "test:tooling"], consumer));
    results.push({
      id: record.id,
      archiveSha256: sha256(archive),
      patchSha256: sha256(patch),
      sourceHashesMatch: true,
      patchAppliesExactly: true,
      commands,
    });
    console.log(
      `Verified ${record.id}: extracted source, patch chain, npm ci, npm test`,
    );
  }
  writeFileSync(
    join(source, "verification.json"),
    JSON.stringify(
      {
        recordedAt: new Date().toISOString(),
        scope:
          "Each recorded archive extracted outside both repositories; patches applied in order from an empty directory; published dependencies installed with npm.",
        results,
      },
      null,
      2,
    ) + "\n",
  );
} finally {
  rmSync(temp, { recursive: true, force: true });
}
