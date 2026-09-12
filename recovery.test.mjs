import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "./server.mjs";
import { START, END } from "./backend.mjs";
import { request, receipt } from "./test-client.mjs";

test("access closes at the exact expiry boundary before the lifecycle observation", async () => {
  const app = startServer();
  try {
    await request(app, "/commerce/v1/purchases/verify", receipt);
    await request(app, "/commerce/v1/purchases/bind", {
      ...receipt,
      userId: "alice",
    });
    app.backend.setClock(END - 1);
    expect(app.backend.state("alice").access).toBe(true);
    app.backend.setClock(END);
    expect(app.backend.state("alice").access).toBe(false);
    expect(
      app.backend.db.query("SELECT state FROM purchases").get().state,
    ).toBe("Active");
    expect(app.backend.expire("alice").changed).toBe(true);
    const events = app.backend.db
      .query("SELECT body FROM outbox ORDER BY rowid")
      .all()
      .map((r) => JSON.parse(r.body));
    expect(events.map((e) => e.eventType)).toEqual([
      "entitlement.granted",
      "subscription.expired",
      "entitlement.revoked",
    ]);
    expect(events.at(-1).subscription.active).toBe(false);
    expect(app.backend.expire("alice").changed).toBe(false);
    expect(() => app.backend.setClock(START)).toThrow();
  } finally {
    await app.close();
  }
});

test("separate process survives abrupt termination with pending events, ownership, inbox, and expiry", async () => {
  const dir = mkdtempSync(join(tmpdir(), "commerce-process-"));
  let child;
  async function start() {
    child = Bun.spawn(
      [process.execPath, new URL("./server.mjs", import.meta.url).pathname],
      {
        cwd: dir,
        env: { ...process.env, PORT: "0" },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const reader = child.stdout.getReader();
    let text = "";
    while (!text.includes("\n")) {
      const chunk = await reader.read();
      if (chunk.done) throw Error("Server stopped before startup");
      text += new TextDecoder().decode(chunk.value);
    }
    reader.releaseLock();
    const url = text.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
    if (!url) throw Error(text);
    return { url };
  }
  try {
    let app = await start();
    await request(app, "/commerce/v1/purchases/verify", receipt);
    await request(app, "/commerce/v1/purchases/bind", {
      ...receipt,
      userId: "alice",
    });
    await request(app, "/demo/deliver", {});
    await request(app, "/fixture/cancel", { userId: "alice" });
    child.kill("SIGKILL");
    await child.exited;
    app = await start();
    let state = await (await fetch(app.url + "/demo/state")).json();
    expect(state.access).toBe(true);
    expect(state.purchases).toBe(1);
    expect(state.inbox).toBe(1);
    expect(state.queued).toBe(1);
    expect(
      (
        await request(app, "/commerce/v1/purchases/bind", {
          ...receipt,
          userId: "bob",
        })
      ).body.bound,
    ).toBe(false);
    await request(app, "/demo/deliver", {});
    state = await (await fetch(app.url + "/demo/state")).json();
    expect(state.inbox).toBe(2);
    expect(state.queued).toBe(0);
    await request(app, "/fixture/clock", { now: END });
    child.kill("SIGKILL");
    await child.exited;
    app = await start();
    expect((await (await fetch(app.url + "/demo/state")).json()).access).toBe(
      false,
    );
    expect(
      (await request(app, "/fixture/expire", { userId: "alice" })).body.changed,
    ).toBe(true);
    await request(app, "/demo/deliver", {});
    expect((await (await fetch(app.url + "/demo/state")).json()).inbox).toBe(4);
  } finally {
    if (child) {
      child.kill();
      await child.exited;
    }
    rmSync(dir, { recursive: true, force: true });
  }
}, 15000);
