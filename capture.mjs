import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  cpSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";
import {
  SOURCE_FILES,
  createPatch,
  extract,
  hashes,
  run,
  sanitize,
  sha256,
  nextAttempt,
} from "./checkpoint-tools.mjs";

const root = import.meta.dir;
const checkpoint = JSON.parse(
  readFileSync(join(root, "checkpoint.json"), "utf8"),
);
assert(
  /^\d\d-[\w-]+$/.test(checkpoint.id),
  "Use a simple checkpoint directory name",
);
const output = join(root, "docs/build", checkpoint.id);
mkdirSync(output, { recursive: true });
assert(
  !existsSync(join(output, "run.json")),
  "Checkpoint already published; choose a new checkpoint id.",
);
const attempt = nextAttempt(output);
const temp = mkdtempSync(join(tmpdir(), "commerce-capture-"));
const current = join(temp, "after"),
  previous = join(temp, "before");
const startedAt = new Date().toISOString();
let lab, browser;
try {
  mkdirSync(current);
  mkdirSync(previous);
  for (const name of SOURCE_FILES) {
    mkdirSync(dirname(join(current, name)), { recursive: true });
    cpSync(join(root, name), join(current, name));
  }
  const sourceHashes = hashes(current);
  if (checkpoint.previous) {
    assert(/^\d\d-[\w-]+$/.test(checkpoint.previous));
    const prior = join(root, "docs/build", checkpoint.previous);
    extract(join(prior, "source.tar.gz"), previous);
    assert.deepEqual(
      hashes(previous),
      JSON.parse(readFileSync(join(prior, "run.json"), "utf8")).sourceHashes,
    );
  }
  writeFileSync(join(output, "changes.patch"), createPatch(previous, current));
  run("env", [
    "COPYFILE_DISABLE=1",
    "tar",
    "-czf",
    join(output, "source.tar.gz"),
    "-C",
    current,
    ...SOURCE_FILES,
  ]);
  const commands = [
    run("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], current),
    run("npm", ["test"], current),
    run("npm", ["run", "test:tooling"], current),
  ];
  writeFileSync(
    join(output, `attempt-${attempt}.txt`),
    JSON.stringify({ startedAt, commands }, null, 2) + "\n",
  );
  const { startLab } = await import(
    pathToFileURL(join(current, "server.mjs")).href
  );
  const { verifyLab } = await import(
    pathToFileURL(join(current, "verify.mjs")).href
  );
  const { STAGES } = await import(
    pathToFileURL(join(current, "scenario.mjs")).href
  );
  const checks = await verifyLab();
  lab = startLab();
  browser = await chromium.launch({ channel: "chrome" });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 1000 },
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(lab.runtime.baseUrl, { waitUntil: "domcontentloaded" });
  for (let step = 1; step <= STAGES.length; step++) {
    await page
      .getByRole("button", { name: `Run step ${step} →`, exact: true })
      .click();
    await page
      .locator("#progress")
      .filter({ hasText: `Milestone ${step} / ${STAGES.length}` })
      .waitFor();
  }
  for (const [filename, viewport] of [
    ["screen.png", { width: 1280, height: 1000 }],
    ["mobile.png", { width: 390, height: 844 }],
  ]) {
    await page.setViewportSize(viewport);
    assert.equal(await page.locator("#error").textContent(), "");
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    const responses = page.locator("#responses details");
    if (await responses.count()) {
      const wasOpen = (await responses.last().getAttribute("open")) !== null;
      if (wasOpen) await responses.last().locator("summary").click();
      assert.equal(await responses.last().getAttribute("open"), null);
      await responses.last().locator("summary").click();
      assert(await responses.last().locator("pre").isVisible());
      if (!wasOpen) await responses.last().locator("summary").click();
    }
    await page.screenshot({ path: join(output, filename), fullPage: true });
  }
  assert.deepEqual(errors, []);
  for (const name of SOURCE_FILES)
    assert.equal(
      sha256(join(current, name)),
      sourceHashes[name],
      "Captured source changed during verification",
    );
  const record = {
    ...checkpoint,
    startedAt,
    recordedAt: new Date().toISOString(),
    packageVersion: JSON.parse(
      readFileSync(
        join(current, "node_modules/openiap-commerce-protocol/package.json"),
        "utf8",
      ),
    ).version,
    task: readFileSync(join(current, "ai-task.md"), "utf8"),
    sourceHashes,
    checks,
    history: lab.scenario.history,
    screenshot: "screen.png",
    scope:
      "Incremental implementation of the installed Commerce Protocol contract. HTTP, SQLite and signatures execute locally; store and clock are fixtures. No full profile claim.",
  };
  writeFileSync(
    join(output, "run.json"),
    JSON.stringify(record, null, 2) + "\n",
  );
  console.log(
    `Captured ${checkpoint.id}: ${checks.length} checks, ${SOURCE_FILES.length} source files.`,
  );
} catch (error) {
  writeFileSync(
    join(output, `failure-${attempt}.txt`),
    `${new Date().toISOString()}\n${sanitize(String(error?.stack ?? error))}\n`,
  );
  throw error;
} finally {
  await browser?.close();
  await lab?.close();
  rmSync(temp, { recursive: true, force: true });
  if (lab) rmSync(lab.directory, { recursive: true, force: true });
}
