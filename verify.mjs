import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import {
  readdirSync,
  readFileSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";

const output = resolve(process.argv[2] ?? ".runtime/verification.json");
const temporary = mkdtempSync(join(tmpdir(), "commerce-verify-"));
function sourceFiles(folder = ".", prefix = "") {
  const files = {};
  for (const entry of readdirSync(folder, { withFileTypes: true }).sort(
    (a, b) => a.name.localeCompare(b.name),
  )) {
    if ([".git", "node_modules", ".runtime"].includes(entry.name)) continue;
    const path = join(folder, entry.name),
      key = prefix + entry.name;
    if (resolve(path) === output) continue;
    if (entry.isDirectory()) Object.assign(files, sourceFiles(path, key + "/"));
    else
      files[key] = createHash("sha256")
        .update(readFileSync(path))
        .digest("hex");
  }
  return files;
}
function git(...args) {
  try {
    return execFileSync("git", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}
const report = {
  startedAt: new Date().toISOString(),
  source: {
    commit: git("rev-parse", "HEAD"),
    status: git("status", "--porcelain"),
    files: sourceFiles(),
  },
  scope:
    "Local store, identity and price fixtures; real HTTP, signatures, SQLite and child-process restart. This does not run an AI, a real store checkout or an external product integration.",
  commands: [],
  checks: [],
  untested: [
    "native SDK checkout",
    "real store validation",
    "external product integration",
    "net revenue, MRR and ARPU",
  ],
  ok: false,
};
async function command(program, args) {
  const record = { command: [program, ...args], stdout: "", stderr: "" };
  report.commands.push(record);
  const child = spawn(program, args, { stdio: ["ignore", "pipe", "pipe"] });
  const timer = setTimeout(() => child.kill("SIGTERM"), 180000);
  child.stdout.on("data", (bytes) => {
    record.stdout += bytes;
  });
  child.stderr.on("data", (bytes) => {
    record.stderr += bytes;
  });
  try {
    [record.exitCode, record.signal] = await once(child, "close");
  } finally {
    clearTimeout(timer);
  }
  assert.equal(
    record.exitCode,
    0,
    `${program} ${args.join(" ")} failed: ${record.stderr}`,
  );
  return record;
}
function passed(id, result, evidence) {
  report.checks.push({ id, result, evidence });
  console.log(`PASS ${id}: ${result}`);
}
let activeServer;
async function start() {
  const record = {
    command: ["bun", "server.mjs"],
    environment: { PORT: "0", DATA_DIR: temporary },
    stdout: "",
    stderr: "",
  };
  report.commands.push(record);
  const child = spawn("bun", ["server.mjs"], {
    env: { ...process.env, ...record.environment },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const closed = once(child, "close");
  activeServer = { child, closed, record };
  child.stdout.on("data", (bytes) => {
    record.stdout += bytes;
  });
  child.stderr.on("data", (bytes) => {
    record.stderr += bytes;
  });
  const url = await new Promise((resolveUrl, reject) => {
    const timer = setTimeout(
      () => reject(Error("Server did not start")),
      10000,
    );
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", () => {
      clearTimeout(timer);
      reject(Error("Server exited before ready"));
    });
    child.stdout.on("data", () => {
      const match = record.stdout.match(
        /Commerce Protocol from scratch: (http:\/\/127\.0\.0\.1:\d+)/,
      );
      if (match) {
        clearTimeout(timer);
        resolveUrl(match[1]);
      }
    });
  });
  return url;
}
async function stop() {
  if (!activeServer) return;
  const { child, closed, record } = activeServer;
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  try {
    [record.exitCode, record.signal] = await closed;
  } finally {
    clearTimeout(timer);
    activeServer = undefined;
  }
}
async function state(url) {
  const response = await fetch(url + "/paywall/state", {
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(response.status, 200);
  return response.json();
}
async function action(url, name, store = "apple", outcome = "success") {
  const request = { store, outcome };
  const destination = url + "/paywall/" + name;
  const response = await fetch(destination, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(30000),
  });
  const body = await response.json();
  report.commands.push({
    method: "POST",
    destination,
    request,
    status: response.status,
    response: body,
  });
  assert.equal(response.status, 200, JSON.stringify(body));
  return body;
}
try {
  const before = sourceFiles();
  for (const role of ["experience", "commerce", "data"]) {
    const cli = await command("npx", [
      "--yes",
      "@hyodotdev/openiap@0.1.0",
      "init",
      "--role",
      role,
    ]);
    assert.match(cli.stdout, /# OpenIAP implementation brief/);
    assert.match(cli.stdout, /Paste this into your coding assistant/);
  }
  assert.deepEqual(sourceFiles(), before);
  passed(
    "cli-handoff",
    "Three roles print AI instructions without changing project files",
    "commands: npx init",
  );
  const tests = await command("npm", ["test"]);
  const conformance = JSON.parse(
    tests.stdout.slice(
      tests.stdout.indexOf("{"),
      tests.stdout.lastIndexOf("}") + 1,
    ),
  );
  assert.equal(conformance.ok, true);
  report.suite = {
    tests: Number(tests.stderr.match(/(\d+) pass/)[1]),
    assertions: Number(tests.stderr.match(/(\d+) expect/)[1]),
    portableCases: conformance.results.length,
  };
  passed(
    "regressions",
    "Behavioral tests and declared REST profile cases pass",
    report.suite,
  );
  let url = await start();
  assert.equal((await state(url)).report.events.length, 0);
  for (const outcome of ["pending", "canceled", "failed"]) {
    const result = await action(url, "buy", "apple", outcome);
    assert.equal(result.finishCalls, 0);
    assert.deepEqual(result.trace, []);
  }
  assert.equal((await state(url)).stores[0].access, false);
  passed(
    "purchase-outcomes",
    "Pending, canceled and failed purchases leave Premium locked",
    "HTTP /paywall/buy",
  );
  assert.equal((await action(url, "buy")).result, "fulfilled");
  assert.equal((await state(url)).report.events.length, 0);
  await action(url, "deliver");
  assert.equal((await state(url)).report.totals[0].amountMicros, 4990000);
  await action(url, "renew");
  await action(url, "deliver");
  await action(url, "cancel");
  await action(url, "deliver");
  const apple = await state(url);
  assert.equal(apple.stores[0].access, true);
  assert.equal(apple.report.events.length, 4);
  assert.equal(apple.report.totals[0].amountMicros, 9980000);
  passed(
    "purchase-renewal-cancel",
    "A has USD 9.98 in fictional observations and retains paid access after cancel",
    apple.report,
  );
  assert.equal((await action(url, "buy", "google")).result, "fulfilled");
  await action(url, "deliver", "google");
  const both = await state(url);
  assert.equal(both.receiver, apple.receiver);
  assert.equal(both.report.events.length, 6);
  assert.equal(both.report.unknownAmounts, 1);
  assert.equal(
    both.report.events.find((event) => event.store === "google").variant,
    "B",
  );
  passed(
    "shared-receiver",
    "Both stores reach the same receiver; B's missing amount stays unknown",
    both.report,
  );
  for (const store of ["apple", "google"])
    await action(url, "redeliver", store);
  assert.deepEqual((await state(url)).report, both.report);
  passed(
    "redelivery",
    "Repeated deliveries change neither counts nor amounts",
    both.report.events.map((event) => event.eventId),
  );
  await stop();
  url = await start();
  const restarted = await state(url);
  assert.deepEqual(restarted.report, both.report);
  assert.deepEqual(restarted.stores, both.stores);
  for (const store of ["apple", "google"])
    await action(url, "redeliver", store);
  assert.deepEqual((await state(url)).report, both.report);
  report.state = restarted;
  passed(
    "process-restart",
    "A new server process preserves access, assignments and event deduplication",
    restarted.report,
  );
  await stop();
  assert.deepEqual(
    sourceFiles(),
    report.source.files,
    "Source changed during verification",
  );
  assert.equal(git("rev-parse", "HEAD"), report.source.commit);
  assert.equal(git("status", "--porcelain"), report.source.status);
  passed(
    "source-stability",
    "Source files and revision stayed unchanged throughout execution",
    report.source.commit,
  );
  report.ok = true;
} catch (error) {
  report.error = error.stack;
  process.exitCode = 1;
  console.error(error.message);
} finally {
  await stop();
  report.finishedAt = new Date().toISOString();
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
  rmSync(temporary, { recursive: true, force: true });
  console.log(`Verification ${report.ok ? "passed" : "failed"}: ${output}`);
}
