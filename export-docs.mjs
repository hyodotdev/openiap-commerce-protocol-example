import assert from "node:assert/strict";
import { readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

const destination = process.argv[2];
if (!destination)
  throw Error(
    "Usage: node export-docs.mjs <existing docs public/commerce-example directory>",
  );
const root = resolve(destination);
const milestones = JSON.parse(readFileSync("milestones.json", "utf8"));
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
const url = `${milestones.repository}/blob/${sourceCommit}`;
// Where this commit is published, which is not milestones.branch: that names
// the lineage the work was built on, not the branch a reader can clone.
const publishedBranch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
  encoding: "utf8",
}).trim();
const tested = JSON.parse(
  readFileSync("evidence/08-tested-final.json", "utf8"),
);
const conformance = JSON.parse(
  tested.stdout.slice(
    tested.stdout.indexOf("{"),
    tested.stdout.lastIndexOf("}") + 1,
  ),
);
if (tested.exitCode !== 0 || !conformance.ok)
  throw Error("Cannot export a failed build");
const verification = {
  tests: Number(tested.stderr.match(/(\d+) pass/)[1]),
  assertions: Number(tested.stderr.match(/(\d+) expect/)[1]),
  portableCases: conformance.results.length,
};
const report = { ...milestones, sourceCommit, verification };
writeFileSync(
  join(root, "fresh-build.json"),
  JSON.stringify(report, null, 2) + "\n",
);
const readme = readFileSync("README.md", "utf8").replace(
  /(!?\[[^\]]*\])\((?!https?:|#)([^)]+)\)/g,
  (_, label, path) =>
    `${label}(${label.startsWith("!") ? `https://raw.githubusercontent.com/hyodotdev/openiap-commerce-protocol-example/${sourceCommit}` : url}/${path})`,
);
// The README tells a reader to clone the development branch, which has no
// stable commit to pin. The published page must name the branch this evidence
// is cut from and the exact commit it records, or a reader follows a moving
// target — and the docs gate refuses a page that disagrees with the recording.
const pinned = readme.replace(
  /git clone --branch \S+ --single-branch (\S+)\ncd (\S+)\n/,
  (line, remote, directory) =>
    `git clone --branch ${publishedBranch} --single-branch ${remote}\n` +
    `cd ${directory}\ngit checkout ${sourceCommit}\n`,
);
assert(
  pinned.includes(`git checkout ${sourceCommit}`),
  "README's clone block did not match; the published page would not pin a commit",
);
writeFileSync(join(root, "from-scratch.md"), pinned);
copyFileSync("evidence/final-screen.jpg", join(root, "fresh-screen.jpg"));
copyFileSync("evidence/final-mobile.jpg", join(root, "fresh-mobile.jpg"));
const archive = execFileSync("git", ["archive", "--format=tar.gz", "HEAD"], {
  maxBuffer: 32 * 1024 * 1024,
});
writeFileSync(join(root, "fresh-source.tar.gz"), archive);
// The consumer pins the archive by hash; derive it from the bytes just written
// so the two can never be written apart.
const build = JSON.parse(readFileSync(join(root, "fresh-build.json"), "utf8"));
build.archiveSha256 = createHash("sha256").update(archive).digest("hex");
writeFileSync(join(root, "fresh-build.json"), JSON.stringify(build, null, 2) + "\n");
console.log(
  `Exported source ${sourceCommit} and ${milestones.milestones.length} real checkpoints.`,
);
