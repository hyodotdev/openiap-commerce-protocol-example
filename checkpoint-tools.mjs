import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

export const SOURCE_FILES = [
  ".gitignore",
  ".yarnrc.yml",
  "LICENSE",
  "AGENTS.md",
  "README.md",
  "BUILD.md",
  "INTEGRATE.md",
  "ai-task.md",
  "checkpoint.json",
  "package.json",
  "package-lock.json",
  "contract.mjs",
  "provider.mjs",
  "erasure.mjs",
  "verify-erasure.mjs",
  "verify-stores.mjs",
  "webhooks.mjs",
  "consumer.mjs",
  "client-bridge.mjs",
  "scenario.mjs",
  "server.mjs",
  "verify.mjs",
  "dashboard.html",
  "composition/README.md",
  "composition/app-backend.mjs",
  "composition/app-backend.test.mjs",
  "composition/receiver.test.mjs",
  "composition/commerce-client.mjs",
  "composition/export.mjs",
  "composition/memory-provider.mjs",
  "composition/purchase-flow.mjs",
  "composition/run.mjs",

  "capture.mjs",
  "export-docs.mjs",
  "checkpoint-tools.mjs",
  "checkpoint-tools.test.mjs",
  "verify-checkpoints.mjs",
];
export const sha256 = (file) =>
  createHash("sha256").update(readFileSync(file)).digest("hex");
export function hashes(directory) {
  const entries = [];
  function visit(relative) {
    for (const name of readdirSync(join(directory, relative)).sort()) {
      const file = join(relative, name);
      if (statSync(join(directory, file)).isDirectory()) visit(file);
      else entries.push([file, sha256(join(directory, file))]);
    }
  }
  visit("");
  return Object.fromEntries(entries);
}
export function sanitize(text) {
  const roots = [process.cwd(), import.meta.dir, homedir()]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  let result = text;
  for (const root of roots) result = result.replaceAll(root, "<local-path>");
  return result.replace(
    /\/[^\s"']*\/commerce-(?:capture|patch|verify|lab|example|compare|consumer)-[^\s/"']+/g,
    "<temporary-project>",
  );
}
export function nextAttempt(directory) {
  return (
    Math.max(
      0,
      ...readdirSync(directory).map((name) =>
        Number(/^(?:attempt|failure)-(\d+)\.txt$/.exec(name)?.[1] ?? 0),
      ),
    ) + 1
  );
}
export function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  const output = sanitize((result.stdout ?? "") + (result.stderr ?? ""));
  assert.equal(result.status, 0, `${command} ${args.join(" ")}\n${output}`);
  return {
    command: [command, ...args].join(" "),
    exitCode: result.status,
    output,
  };
}
export function extract(archive, target) {
  mkdirSync(target, { recursive: true });
  // Older macOS archives contain AppleDouble metadata, not source files.
  run("tar", [
    ...(process.platform === "darwin" ? ["--no-mac-metadata"] : []),
    "--exclude=._*",
    "-xzf",
    archive,
    "-C",
    target,
  ]);
}
export function normalizePatch(patch) {
  return patch
    .split("\n")
    .map((line) => {
      if (/^(diff --git |--- a\/|\+\+\+ b\/)/.test(line)) {
        return line.replace(/([ab])\/(?:before|after)\//g, "$1/");
      }
      return line;
    })
    .join("\n");
}
export function createPatch(before, after) {
  const temp = mkdtempSync(join(tmpdir(), "commerce-patch-"));
  try {
    cpSync(before, join(temp, "before"), { recursive: true });
    cpSync(after, join(temp, "after"), { recursive: true });
    const result = spawnSync(
      "git",
      ["diff", "--no-index", "--no-ext-diff", "--", "before", "after"],
      { cwd: temp, encoding: "utf8", maxBuffer: 20 * 1024 * 1024 },
    );
    assert([0, 1].includes(result.status), result.stderr);
    const patch = normalizePatch(result.stdout);
    writeFileSync(join(temp, "changes.patch"), patch);
    cpSync(before, join(temp, "applied"), { recursive: true });
    if (patch)
      run("git", ["apply", join(temp, "changes.patch")], join(temp, "applied"));
    assert.deepEqual(
      hashes(join(temp, "applied")),
      hashes(after),
      "Patch must reproduce the source archive exactly",
    );
    return patch;
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
export function readRecords(directory) {
  const records = readdirSync(directory)
    .filter(
      (name) =>
        /^\d\d-[\w-]+$/.test(name) &&
        existsSync(join(directory, name, "run.json")),
    )
    .sort()
    .map((name) =>
      JSON.parse(readFileSync(join(directory, name, "run.json"), "utf8")),
    );
  const byId = new Map(records.map((record) => [record.id, record]));
  const ordered = [],
    visiting = new Set(),
    visited = new Set();
  function visit(record) {
    if (visited.has(record.id)) return;
    assert(!visiting.has(record.id), `Checkpoint cycle: ${record.id}`);
    visiting.add(record.id);
    if (record.previous) {
      assert(
        byId.has(record.previous),
        `Missing predecessor: ${record.previous}`,
      );
      visit(byId.get(record.previous));
    }
    visiting.delete(record.id);
    visited.add(record.id);
    ordered.push(record);
  }
  records.forEach(visit);
  return ordered;
}
