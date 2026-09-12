import { readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { execFileSync } from "node:child_process";

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
writeFileSync(join(root, "from-scratch.md"), readme);
copyFileSync("evidence/final-screen.png", join(root, "fresh-screen.png"));
copyFileSync("evidence/final-mobile.png", join(root, "fresh-mobile.png"));
writeFileSync(
  join(root, "fresh-source.tar.gz"),
  execFileSync("git", ["archive", "--format=tar.gz", "HEAD"], {
    maxBuffer: 32 * 1024 * 1024,
  }),
);
console.log(
  `Exported source ${sourceCommit} and ${milestones.milestones.length} real checkpoints.`,
);
