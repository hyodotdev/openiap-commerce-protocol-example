import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";

const [destination, verificationFile, providerFile] = process.argv.slice(2);
if (!destination || !verificationFile)
  throw Error(
    "Usage: node export-paywall.mjs <docs public/commerce-example> <verification.json> [provider-report.json]",
  );
const root = resolve(destination);
const run = JSON.parse(readFileSync(verificationFile, "utf8"));
assert(
  run.ok && run.source.status === "" && run.source.commit,
  "Export requires a successful clean-source verification",
);
const sourceCommit = run.source.commit;
const repository =
  "https://github.com/hyodotdev/openiap-commerce-protocol-example";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const read = (path) =>
  execFileSync("git", ["show", `${sourceCommit}:${path}`], {
    maxBuffer: 32 * 1024 * 1024,
  });
for (const [file, expected] of Object.entries(run.source.files))
  assert.equal(hash(read(file)), expected, `Executed source differs: ${file}`);
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
  archiveSha256: hash(archive),
  verification: run.suite,
  state: run.state,
  browserSourceCommit: "abdbcef40fc710540853aa46e0b374711b6047ba",
  browser: JSON.parse(read("evidence/paywall-browser.json")),
  harness: { checks: run.checks.length, recordedAt: run.finishedAt },
};
if (providerFile) {
  const provider = JSON.parse(readFileSync(providerFile, "utf8"));
  assert(provider.freshConnection?.ok);
  assert.equal(provider.freshConnection.source.revision, sourceCommit);
  for (const [file, expected] of Object.entries(
    provider.freshConnection.source.hashes,
  ))
    assert.equal(
      hash(read(file)),
      expected,
      `Provider consumer source differs: ${file}`,
    );
  build.providerVerification = {
    checks: provider.freshConnection.checks.length,
    regressionChecks: provider.checkCount,
    recordedAt: provider.recordedAt,
    state: provider.freshConnection.state,
  };
  writeFileSync(
    join(root, "paywall-provider-run.json"),
    JSON.stringify(provider, null, 2) + "\n",
  );
}
writeFileSync(
  join(root, "paywall-build.json"),
  JSON.stringify(build, null, 2) + "\n",
);
writeFileSync(join(root, "paywall-source.tar.gz"), archive);
writeFileSync(
  join(root, "paywall-harness.json"),
  JSON.stringify(run, null, 2) + "\n",
);
for (const file of ["paywall-screen.jpg", "paywall-mobile.jpg"])
  writeFileSync(join(root, file), read("evidence/" + file));
const guide = read("PAYWALL.md")
  .toString()
  .replace("[Final test output]", "[Initial connection test output]")
  .replace(
    /(!?\[[^\]]*\])\((?!https?:|#)([^)]+)\)/g,
    (_, label, path) => `${label}(${repository}/blob/${sourceCommit}/${path})`,
  );
writeFileSync(
  join(root, "paywall-verification.md"),
  guide +
    `\nVerified source: [${sourceCommit}](${repository}/tree/${sourceCommit}).\n` +
    "[Recorded CLI, tests, HTTP and restart results](./paywall-harness.json).\n" +
    (providerFile
      ? "[Independent provider run](./paywall-provider-run.json) · [Exact sources and commands to reproduce it](./paywall-provider-reproduction.md).\n"
      : ""),
);
console.log(`Exported verified connection at ${sourceCommit}`);
