import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SOURCE_FILES } from "../checkpoint-tools.mjs";
import { COMPOSITION_SOURCES, runComposition } from "./run.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
assert(
  process.argv[2],
  "Usage: bun composition/export.mjs <documentation-assets-directory>",
);
const output = resolve(process.argv[2]);
const temp = mkdtempSync(join(tmpdir(), "commerce-composition-export-"));
const source = join(temp, "source"),
  replay = join(temp, "replay");
const run = (command, args, cwd) => {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 5 * 1024 * 1024,
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
  assert.equal(
    result.status,
    0,
    `${command} failed: ${result.stderr}\n${result.stdout}`,
  );
};
try {
  const report = await runComposition();
  const names = [
    ...new Set([
      ...SOURCE_FILES,
      ...COMPOSITION_SOURCES,
      "composition/export.mjs",
    ]),
  ].sort();
  for (const name of names) {
    mkdirSync(dirname(join(source, name)), { recursive: true });
    cpSync(join(root, name), join(source, name));
  }
  mkdirSync(output, { recursive: true });
  const archive = join(output, "source.tar.gz");
  run("tar", ["-czf", archive, ...names], source);
  mkdirSync(replay);
  run("tar", ["-xzf", archive, "-C", replay], temp);
  run("npm", ["ci", "--ignore-scripts"], replay);
  run(
    process.execPath,
    ["composition/run.mjs", "--record", "replay.json"],
    replay,
  );
  const replayed = JSON.parse(
    readFileSync(join(replay, "replay.json"), "utf8"),
  );
  assert.deepEqual(replayed.sourceHashes, report.sourceHashes);
  assert.deepEqual(replayed.results, report.results);
  assert.deepEqual(replayed.checks, report.checks);
  const providerPath = join(replay, "provider.mjs");
  const original = readFileSync(providerPath, "utf8");
  assert(original.includes("now < expiresAt"));
  writeFileSync(
    providerPath,
    original.replace("now < expiresAt", "now <= expiresAt"),
  );
  const negative = spawnSync(process.execPath, ["composition/run.mjs"], {
    cwd: replay,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  const rejectedCheck =
    "sqlite: read closes access at the deadline before a notification";
  assert.equal(negative.status, 1);
  assert(
    (negative.stderr + negative.stdout).includes(rejectedCheck),
    "Negative control must fail the intended assertion",
  );
  report.negativeControl = {
    change:
      "Replace now < expiresAt with now <= expiresAt in a temporary provider copy",
    detected: true,
    rejectedCheck,
  };
  report.archiveVerification = {
    command: "npm ci --ignore-scripts && bun composition/run.mjs",
    sameSourceAndResults: true,
    sha256: createHash("sha256").update(readFileSync(archive)).digest("hex"),
  };
  writeFileSync(
    join(output, "run.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  writeFileSync(
    join(output, "source.json"),
    JSON.stringify(
      Object.fromEntries(
        [
          "composition/commerce-client.mjs",
          "composition/purchase-flow.mjs",
          "composition/memory-provider.mjs",
          "composition/run.mjs",
        ].map((name) => [name, readFileSync(join(source, name), "utf8")]),
      ),
      null,
      2,
    ) + "\n",
  );
  cpSync(join(root, "composition/README.md"), join(output, "README.md"));
  console.log(
    `Exported ${report.checks.length} composition checks with a clean-install archive replay.`,
  );
} finally {
  rmSync(temp, { recursive: true, force: true });
}
