import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "./server.mjs";
import { request } from "./test-client.mjs";
import { PAYWALL_STORES } from "./paywall-fixtures.mjs";
import { sign, WEBHOOK_SECRET } from "./delivery.mjs";

async function act(app, action, store = "apple", outcome = "success") {
  return request(app, "/paywall/" + action, { store, outcome });
}
async function postEvent(app, event, alteredBody) {
  const body = JSON.stringify(event);
  const timestamp = Math.floor(Date.now() / 1000);
  return fetch(app.receiver.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "openiap-timestamp": String(timestamp),
      "openiap-signature": sign(WEBHOOK_SECRET, timestamp, body),
    },
    body: alteredBody ?? body,
  });
}

test("paywall purchase, renewal and cancellation join two store fixtures to the same experiment receiver", async () => {
  const app = startServer();
  try {
    const purchase = await act(app, "buy");
    expect(purchase.status).toBe(200);
    expect(purchase.body.result).toBe("fulfilled");
    expect(purchase.body.finishCalls).toBe(1);
    expect(
      purchase.body.trace.map((item) => new URL(item.destination).pathname),
    ).toEqual([
      "/commerce/v1/purchases/verify",
      "/commerce/v1/purchases/bind",
      "/commerce/v1/entitlements",
    ]);
    expect(app.attribution.report().events).toHaveLength(0);
    await act(app, "deliver");
    let report = app.attribution.report();
    expect(report.events).toHaveLength(2);
    expect(report.totals).toEqual([
      {
        currency: "USD",
        experiment: "onboarding",
        variant: "A",
        amountMicros: 4990000,
      },
    ]);
    await act(app, "renew");
    await act(app, "deliver");
    await act(app, "cancel");
    await act(app, "deliver");
    report = app.attribution.report();
    expect(report.events).toHaveLength(4);
    expect(report.totals[0].amountMicros).toBe(9980000);
    expect(report.events.at(-1).treatment).toBe("lifecycle only");
    expect(app.backend.status({ userId: "alice-apple" }).active).toBe(true);
    expect((await act(app, "buy", "google")).body.result).toBe("fulfilled");
    await act(app, "deliver", "google");
    report = app.attribution.report();
    expect(report.events).toHaveLength(6);
    expect(report.unknownAmounts).toBe(1);
    expect(report.events.find((item) => item.store === "google").variant).toBe(
      "B",
    );
    expect(report.totals).toHaveLength(1);
    await act(app, "redeliver", "apple");
    await act(app, "redeliver", "google");
    expect(app.attribution.report()).toEqual(report);
  } finally {
    await app.close();
  }
});

test("unsuccessful store results and denied ownership never finish a purchase", async () => {
  const app = startServer();
  try {
    for (const outcome of ["pending", "canceled", "failed"]) {
      const response = await act(app, "buy", "apple", outcome);
      expect(response.body.result).toBe(outcome);
      expect(response.body.finishCalls).toBe(0);
      expect(response.body.trace).toEqual([]);
    }
    expect(app.backend.state().purchases).toBe(0);
    const receipt = PAYWALL_STORES[0].receipt;
    await request(app, "/commerce/v1/purchases/verify", receipt);
    await request(app, "/commerce/v1/purchases/bind", {
      ...receipt,
      userId: "another-owner",
    });
    const denied = await act(app, "buy");
    expect(denied.body.result).toBe("failed");
    expect(denied.body.finishCalls).toBe(0);
    expect(app.backend.status({ userId: "alice-apple" }).active).toBe(false);
  } finally {
    await app.close();
  }
});

test("reporting uses event IDs, preserves currencies and unknowns, and leaves refunds for reconciliation", async () => {
  const app = startServer();
  try {
    await act(app, "buy");
    await act(app, "deliver");
    const original = JSON.parse(
      app.receiver.db
        .query("SELECT body FROM inbox ORDER BY rowid LIMIT 1")
        .get().body,
    );
    expect((await postEvent(app, original)).status).toBe(202);
    expect(
      (
        await postEvent(
          app,
          original,
          JSON.stringify({
            ...original,
            price: { ...original.price, amountMicros: 9999999 },
          }),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await postEvent(app, {
          ...original,
          eventId: "wrong-project",
          projectId: "other-project",
        })
      ).status,
    ).toBe(403);
    expect(app.attribution.report().totals[0].amountMicros).toBe(4990000);
    const variants = [
      {
        eventId: "eur",
        eventType: "subscription.renewed",
        price: { ...original.price, currency: "EUR", amountMicros: 3000000 },
      },
      {
        eventId: "catalog",
        price: { ...original.price, provenance: "catalog" },
      },
      {
        eventId: "inferred",
        price: { ...original.price, provenance: "inferred" },
      },
      {
        eventId: "refund",
        eventType: "subscription.refunded",
        subscription: {
          ...original.subscription,
          state: "Refunded",
          active: false,
        },
      },
      { eventId: "recovered", eventType: "subscription.recovered" },
    ];
    for (const variant of variants)
      expect((await postEvent(app, { ...original, ...variant })).status).toBe(
        202,
      );
    const report = app.attribution.report();
    expect(
      report.totals.map((item) => [item.currency, item.amountMicros]),
    ).toEqual([
      ["USD", 4990000],
      ["EUR", 3000000],
    ]);
    expect(report.unknownAmounts).toBe(2);
    expect(report.reconciliation).toBe(2);
    expect(
      report.events.filter(
        (item) => item.transactionId === original.transactionId,
      ),
    ).toHaveLength(7);
    // A new store token uses the same receiver, with no inferred attribution.
    expect(
      (
        await postEvent(app, {
          ...original,
          eventId: "future-store",
          store: "future_store",
        })
      ).status,
    ).toBe(202);
    expect(app.attribution.report().events.at(-1).variant).toBe(null);
  } finally {
    await app.close();
  }
});

test("event-to-experiment joins survive reopening, reject reassignment, and erase with the customer", async () => {
  const folder = mkdtempSync(join(tmpdir(), "commerce-attribution-"));
  const options = {
    path: join(folder, "provider.sqlite"),
    receiverPath: join(folder, "receiver.sqlite"),
  };
  let app = startServer(options);
  try {
    await act(app, "buy");
    await act(app, "deliver");
    const expected = app.attribution.report();
    app.attribution.assign({ ...PAYWALL_STORES[0], variant: "B" });
    expect(app.attribution.report()).toEqual(expected);
    await app.close();
    app = startServer(options);
    await act(app, "redeliver");
    expect(app.attribution.report()).toEqual(expected);
    const replay = JSON.parse(
      app.receiver.db.query("SELECT body FROM inbox LIMIT 1").get().body,
    );
    app.receiver.erase("alice-apple");
    expect(
      app.receiver.db.query("SELECT count(*) n FROM attribution").get().n,
    ).toBe(0);
    expect((await postEvent(app, replay)).status).toBe(202);
    expect(app.attribution.report().events).toHaveLength(0);
    const late = await fetch(app.url + "/paywall/buy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ store: "apple" }),
    });
    expect(late.status).toBe(403);
    expect(
      app.receiver.db.query("SELECT count(*) n FROM attribution").get().n,
    ).toBe(0);
  } finally {
    await app.close();
    rmSync(folder, { recursive: true, force: true });
  }
});
