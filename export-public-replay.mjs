// Records a public replay of this branch: clone what a reader clones, check out
// the commit the docs name, install from the committed lockfile, run the tests,
// and confirm the tree is clean. Every field is the real output of a real run —
// nothing here is authored by hand, because the page it feeds is evidence.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const destination = process.argv[2];
const scope = process.argv[3];
if (!destination || !scope)
  throw Error(
    "Usage: node export-public-replay.mjs <docs public/commerce-example> <scope sentence>",
  );

const branch = "docs/example-backend-reference";
const repository =
  "https://github.com/hyodotdev/openiap-commerce-protocol-example.git";
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
assert.equal(
  execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }),
  "",
  "Refusing to record a replay from a dirty checkout",
);

const workspace = mkdtempSync(join(tmpdir(), "commerce-backend-public-"));
const source = join(workspace, "source");
const steps = [];
const run = (command, cwd) => {
  const result = spawnSync(command[0], command.slice(1), {
    cwd,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  steps.push({
    command,
    cwd,
    exitCode: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  });
  assert.equal(result.status, 0, `${command.join(" ")}\n${result.stderr}`);
};

try {
  run(["git", "clone", "--branch", branch, "--single-branch", repository, source], workspace);
  run(["git", "checkout", sourceCommit], source);
  run(["npm", "ci"], source);
  run(["npm", "test"], source);
  run(["git", "status", "--porcelain"], source);
  assert.equal(
    steps.at(-1).stdout,
    "",
    "The published checkout must be clean after install and test",
  );
  writeFileSync(
    join(resolve(destination), "fresh-public-replay.json"),
    JSON.stringify(
      { recordedAt: new Date().toISOString(), sourceCommit, scope, steps },
      null,
      2,
    ) + "\n",
  );
  console.log(`Recorded a public replay of ${sourceCommit} in ${steps.length} steps.`);
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
