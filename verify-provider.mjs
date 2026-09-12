import assert from "node:assert/strict";
import { startReceiver } from "./delivery.mjs";
import { openAttribution, eraseAttribution } from "./attribution.mjs";
import { handlePaywall } from "./paywall.mjs";

// The provider harness supplies real handlers with fixture store boundaries.
export async function verifyProvider({
  provider,
  projectId,
  secret,
  sample,
  observe,
  deliver,
}) {
  const receiver = startReceiver({
    projectId,
    secret,
    onErase: eraseAttribution,
  });
  const attribution = openAttribution(receiver.db, { projectId });
  const trace = [],
    deliveries = [],
    checks = [];
  const app = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) =>
      handlePaywall(request, {
        provider,
        stores: [sample],
        receiver,
        attribution,
        assign: () =>
          attribution.assignAccount({
            store: sample.id,
            environment: "production",
            userId: sample.userId,
            productId: sample.productId,
            experiment: "onboarding",
            variant: sample.variant,
          }),
      }),
  });
  function check(label, actual, expected) {
    assert.deepEqual(actual, expected, label);
    checks.push(label);
  }
  async function buy(outcome = "success") {
    const response = await fetch(app.url.origin + "/paywall/buy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ store: sample.id, outcome }),
    });
    const result = await response.json();
    trace.push({ action: "buy", outcome, status: response.status, result });
    check("paywall request succeeds", response.status, 200);
    return result;
  }
  async function drain() {
    await deliver(async (request) => {
      const response = await fetch(receiver.url, {
        method: "POST",
        headers: request.headers,
        body: request.body,
      });
      deliveries.push({
        headers: request.headers,
        body: request.body,
        status: response.status,
      });
      return response.status;
    });
  }
  try {
    for (const outcome of ["pending", "canceled", "failed"])
      check(
        "unsuccessful purchase never finishes",
        (await buy(outcome)).finishCalls,
        0,
      );
    const bought = await buy();
    check("configured provider fulfills purchase", bought.result, "fulfilled");
    check(
      "actual requests target the configured provider",
      bought.trace.map((item) => new URL(item.destination).origin),
      Array(3).fill(provider.baseUrl),
    );
    check(
      "verification and binding alone create no consumer events",
      attribution.report().events.length,
      0,
    );
    await observe("purchase");
    await drain();
    const initial = attribution.report();
    check(
      "provider purchase reaches trusted experiment assignment",
      initial.events.find((event) => event.eventType === "subscription.started")
        ?.variant,
      sample.variant,
    );
    check(
      "provider price is read without fixture substitution",
      initial.totals[0]?.amountMicros,
      5000000,
    );
    await observe("renew");
    await drain();
    const renewed = attribution.report();
    check(
      "renewal reaches same experiment assignment",
      renewed.events.find((event) => event.eventType === "subscription.renewed")
        ?.variant,
      sample.variant,
    );
    check(
      "renewal adds the provider's observation amount",
      renewed.totals[0]?.amountMicros,
      10000000,
    );
    await observe("cancel");
    await drain();
    const canceled = attribution.report();
    check("cancellation preserves amount", canceled.totals, renewed.totals);
    const state = await (await fetch(app.url.origin + "/paywall/state")).json();
    check(
      "access is read from the configured provider after cancellation",
      state.stores[0].access,
      true,
    );
    for (const delivery of [...deliveries])
      await fetch(receiver.url, {
        method: "POST",
        headers: delivery.headers,
        body: delivery.body,
      });
    check(
      "repeated signed delivery leaves report unchanged",
      attribution.report(),
      canceled,
    );
    const event = JSON.parse(deliveries[0].body);
    check(
      "missing transaction references remain missing",
      [event.originalTransactionId ?? null, event.transactionId ?? null],
      [null, null],
    );
    return {
      ok: true,
      checks,
      trace,
      deliveries,
      state,
      scope:
        "Same paywall handler and receiver, configured for a second local provider. Trusted account/product attribution is explicit; no purchase migration or real store checkout.",
    };
  } finally {
    await app.stop(true);
    await receiver.close();
  }
}
