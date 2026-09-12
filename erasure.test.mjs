import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "./server.mjs";
import { request, receipt } from "./test-client.mjs";
import { sign, WEBHOOK_SECRET, createDelivery } from "./delivery.mjs";

test("provider and recipient erase independently; late events, stale sessions, and repeated erasure cannot restore Alice", async () => {
  const dir = mkdtempSync(join(tmpdir(), "commerce-erasure-"));
  const options = {
    path: join(dir, "provider.sqlite"),
    receiverPath: join(dir, "receiver.sqlite"),
  };
  let app = startServer(options);
  try {
    for (const [userId, input] of [
      ["alice", receipt],
      ["bob", { store: "fixture", fixture: { receipt: "bob-monthly" } }],
    ]) {
      await request(app, "/commerce/v1/purchases/verify", input);
      await request(app, "/commerce/v1/purchases/bind", { ...input, userId });
    }
    await app.delivery.sendDue();
    const aliceEvent = app.receiver.db
      .query("SELECT body FROM inbox WHERE user_id='alice'")
      .get().body;
    const acknowledgement = await request(app, "/commerce/v1/users/erase", {
      userId: "alice",
    });
    expect(acknowledgement.status).toBe(202);
    expect(acknowledgement.body.status).toBe("completed");
    expect(
      app.receiver.db
        .query("SELECT count(*) n FROM inbox WHERE user_id='alice'")
        .get().n,
    ).toBe(1);
    app.receiver.erase("alice");
    expect(
      app.backend.db
        .query("SELECT count(*) n FROM purchases WHERE user_id='alice'")
        .get().n,
    ).toBe(0);
    expect(
      app.backend.db
        .query("SELECT count(*) n FROM outbox WHERE user_id='alice'")
        .get().n,
    ).toBe(0);
    expect(app.backend.state("bob").access).toBe(true);
    await app.close();
    app = startServer(options);
    expect(
      (await request(app, "/commerce/v1/users/erase", { userId: "alice" }))
        .body,
    ).toEqual(acknowledgement.body);
    expect(
      (
        await request(app, "/commerce/v1/purchases/bind", {
          ...receipt,
          userId: "bob",
        })
      ).body.bound,
    ).toBe(false);
    expect((await request(app, "/demo/bind", { user: "alice" })).status).toBe(
      403,
    );
    const timestamp = Math.floor(Date.now() / 1000);
    const late = await fetch(app.receiver.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "openiap-timestamp": String(timestamp),
        "openiap-signature": sign(WEBHOOK_SECRET, timestamp, aliceEvent),
      },
      body: aliceEvent,
    });
    expect(late.status).toBe(202);
    expect(app.receiver.db.query("SELECT count(*) n FROM inbox").get().n).toBe(
      1,
    );
    expect(app.backend.state("alice").access).toBe(false);
    expect(app.backend.state("bob").access).toBe(true);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("erasure during an in-flight delivery removes both copies and queued follow-ups", async () => {
  const app = startServer();
  let proxy;
  try {
    await request(app, "/commerce/v1/purchases/verify", receipt);
    await request(app, "/commerce/v1/purchases/bind", {
      ...receipt,
      userId: "alice",
    });
    await request(app, "/fixture/cancel", { userId: "alice" });
    proxy = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        app.receiver.erase("alice");
        app.backend.erase("alice");
        return fetch(app.receiver.url, {
          method: "POST",
          headers: req.headers,
          body: await req.arrayBuffer(),
        });
      },
    });
    const delivery = createDelivery(
      app.backend,
      proxy.url.origin + "/webhooks/commerce",
    );
    await delivery.sendDue();
    expect(app.backend.db.query("SELECT count(*) n FROM outbox").get().n).toBe(
      0,
    );
    expect(app.receiver.db.query("SELECT count(*) n FROM inbox").get().n).toBe(
      0,
    );
    expect(app.backend.state("alice").access).toBe(false);
  } finally {
    if (proxy) await proxy.stop(true);
    await app.close();
  }
});
