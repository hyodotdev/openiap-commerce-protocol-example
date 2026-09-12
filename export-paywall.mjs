import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";

const destination = process.argv[2];
if (!destination)
  throw Error("Usage: node export-paywall.mjs <docs public/commerce-example>");
const root = resolve(destination);
const replay = JSON.parse(
  readFileSync("evidence/paywall-public-replay.json", "utf8"),
);
if (
  !replay.records.every((item) => item.exitCode === 0) ||
  !replay.runtime.reportSurvivedRestart
)
  throw Error("Cannot publish an unsuccessful replay");
const sourceCommit = replay.sourceCommit;
const repository =
  "https://github.com/hyodotdev/openiap-commerce-protocol-example";
const read = (path) =>
  execFileSync("git", ["show", `${sourceCommit}:${path}`], {
    maxBuffer: 32 * 1024 * 1024,
  });
const tested = JSON.parse(read("evidence/paywall-tests.json"));
const conformance = JSON.parse(
  tested.stdout.slice(
    tested.stdout.indexOf("{"),
    tested.stdout.lastIndexOf("}") + 1,
  ),
);
if (tested.exitCode !== 0 || !conformance.ok)
  throw Error("Source tests failed");
const archive = execFileSync(
  "git",
  ["archive", "--format=tar.gz", sourceCommit],
  { maxBuffer: 32 * 1024 * 1024 },
);
const build = {
  repository,
  branch: "codex/commerce-protocol-from-scratch",
  sourceCommit,
  implementationCommit: sourceCommit,
  archiveSha256: createHash("sha256").update(archive).digest("hex"),
  verification: {
    tests: Number(tested.stderr.match(/(\d+) pass/)[1]),
    assertions: Number(tested.stderr.match(/(\d+) expect/)[1]),
    portableCases: conformance.results.length,
  },
  state: JSON.parse(read("evidence/paywall-state.json")),
  browser: JSON.parse(read("evidence/paywall-browser.json")),
};
writeFileSync(
  join(root, "paywall-build.json"),
  JSON.stringify(build, null, 2) + "\n",
);
writeFileSync(join(root, "paywall-source.tar.gz"), archive);
writeFileSync(
  join(root, "paywall-public-replay.json"),
  JSON.stringify(replay, null, 2) + "\n",
);
for (const file of ["paywall-screen.jpg", "paywall-mobile.jpg"])
  writeFileSync(join(root, file), read("evidence/" + file));
const guide = read("PAYWALL.md")
  .toString()
  .replace(
    /(!?\[[^\]]*\])\((?!https?:|#)([^)]+)\)/g,
    (_, label, path) => `${label}(${repository}/blob/${sourceCommit}/${path})`,
  );
writeFileSync(
  join(root, "paywall-verification.md"),
  guide +
    "\n[Fresh public-clone install, CLI output, HTTP flow and restart verification](./paywall-public-replay.json).\n",
);
console.log(`Exported verified connection at ${sourceCommit}`);
