import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WEBHOOK, COMMERCE_EVENT_VERSION } from "openiap-commerce-protocol";
import { createReceiver, sign } from "../webhooks.mjs";
import { runComposition } from "./run.mjs";

test("the original SQLite and memory composition remains compatible with the receiver", async () => {
  const report = await runComposition();
  expect(report.checks.length).toBeGreaterThan(0);
});

test("one inbox scopes event IDs to authenticated emitters, survives upgrade, and discards erased users", async () => {
  const directory = mkdtempSync(join(tmpdir(), "commerce-receiver-"));
  const path = join(directory, "inbox.sqlite");
  const now = Date.now();
  const emitters = [
    { name: "example", projectId: "example_project", secret: "example-key" },
    { name: "iapkit", projectId: "kit_project", secret: "kit-key" },
  ];
  const event = {
    eventId: "same-event-id",
    eventType: "subscription.canceled",
    eventVersion: COMMERCE_EVENT_VERSION,
    occurredAt: now,
    processedAt: now,
    store: "fixture",
    environment: "local-fixture",
    projectId: emitters[0].projectId,
    userId: "alice",
    productId: "premium.monthly",
    subscription: {
      productId: "premium.monthly",
      state: "Active",
      active: true,
      expiresAt: now + 60000,
      willRenew: false,
    },
  };
  const old = new Database(path, { create: true });
  old.exec(
    "CREATE TABLE inbox (event_id TEXT PRIMARY KEY, body TEXT NOT NULL)",
  );
  old
    .query("INSERT INTO inbox VALUES (?, ?)")
    .run(event.eventId, JSON.stringify(event));
  old.close();
  let receiver = createReceiver(path, emitters, () => now);
  const post = (emitter, value) => {
    const body = JSON.stringify(value),
      timestamp = String(Math.floor(now / 1000));
    return receiver.fetch(
      new Request("http://localhost/webhooks/commerce", {
        method: "POST",
        body,
        headers: {
          [WEBHOOK.timestampHeader]: timestamp,
          [WEBHOOK.signatureHeader]: sign(emitter.secret, timestamp, body),
          [WEBHOOK.eventIdHeader]: value.eventId,
        },
      }),
    );
  };
  try {
    expect(await (await post(emitters[0], event)).json()).toEqual({
      accepted: true,
      duplicate: true,
    });
    const kitEvent = { ...event, projectId: emitters[1].projectId };
    expect((await post(emitters[0], kitEvent)).status).toBe(401);
    expect(receiver.count()).toBe(1);
    expect(await (await post(emitters[1], kitEvent)).json()).toEqual({
      accepted: true,
      duplicate: false,
    });
    expect(receiver.count()).toBe(2);
    receiver.close();
    receiver = createReceiver(path, emitters, () => now);
    expect(await (await post(emitters[1], kitEvent)).json()).toEqual({
      accepted: true,
      duplicate: true,
    });
    expect(receiver.eraseUser("alice")).toBe(2);
    receiver.close();
    receiver = createReceiver(path, emitters, () => now);
    for (const emitter of emitters)
      expect(
        await (
          await post(emitter, {
            ...event,
            projectId: emitter.projectId,
            eventId: "late-event",
          })
        ).json(),
      ).toEqual({ accepted: true, discarded: "erased-user" });
    expect(receiver.count()).toBe(0);
  } finally {
    receiver.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
