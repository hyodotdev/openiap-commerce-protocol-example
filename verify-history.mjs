import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const revisions = spawnSync("git", ["rev-list", "--reverse", "HEAD"], {
  encoding: "utf8",
})
  .stdout.trim()
  .split("\n");
const results = [];
for (const revision of revisions) {
  const dir = mkdtempSync(join(tmpdir(), "commerce-checkout-"));
  const commands = [];
  try {
    const archive = spawnSync("git", ["archive", revision], {
      maxBuffer: 32 * 1024 * 1024,
    });
    if (archive.status) throw Error("git archive failed");
    const extraction = spawnSync("tar", ["-xf", "-", "-C", dir], {
      input: archive.stdout,
    });
    if (extraction.status) throw Error("tar extraction failed");
    for (const command of [
      ["npm", "ci"],
      ...(existsSync(join(dir, "server.mjs")) ? [["npm", "test"]] : []),
    ]) {
      const run = spawnSync(command[0], command.slice(1), {
        cwd: dir,
        encoding: "utf8",
        timeout: 60000,
        maxBuffer: 16 * 1024 * 1024,
      });
      commands.push({
        command,
        exitCode: run.status,
        stdout: run.stdout,
        stderr: run.stderr,
        error: run.error?.message,
      });
      if (run.status !== 0) break;
    }
    const ok = commands.every((run) => run.exitCode === 0);
    results.push({
      revision,
      ok,
      bootstrapOnly: !existsSync(join(dir, "server.mjs")),
      commands,
    });
    console.log(
      `${ok ? "PASS" : "FAIL"} ${revision.slice(0, 7)}: ${commands.map((x) => x.command.join(" ")).join(" → ")}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const report = {
  recordedAt: new Date().toISOString(),
  scope:
    "Each actual commit extracted into an empty directory; no development database or node_modules reused.",
  ok: results.every((r) => r.ok),
  results,
};
writeFileSync(
  "evidence/history-replay.json",
  JSON.stringify(report, null, 2) + "\n",
);
if (!report.ok) process.exitCode = 1;
