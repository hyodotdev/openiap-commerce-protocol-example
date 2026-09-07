import assert from "node:assert/strict";
import { operation, validate } from "./contract.mjs";
import { CREDENTIALS, FIXTURE } from "./provider.mjs";
import { deliver } from "./webhooks.mjs";

export const STAGES = [
  {
    title: "Start with the contract",
    built: "HTTP routes + schema validation + SQLite",
    result: "A running server, an empty purchase table, and no access.",
  },
  {
    title: "Verify a purchase",
    built: "Fixture store adapter + purchase persistence",
    result: "Valid evidence is saved. Alice still has no access.",
  },
  {
    title: "Connect it to a user",
    built: "Server authorization + atomic binding + entitlement reads",
    result: "Alice gets Premium. Another user cannot take the purchase.",
  },
  {
    title: "Handle cancellation",
    built: "Lifecycle processing + transactional event outbox",
    result: "Renewal stops. Alice keeps the time she already paid for.",
  },
  {
    title: "Deliver, retry, deduplicate",
    built: "HMAC signatures + retry worker + durable receiver inbox",
    result:
      "A 503 retries successfully. Redelivery creates no second inbox row.",
  },
  {
    title: "Expire access and restart",
    built: "Expiry-aware reads + recovery from SQLite",
    result:
      "Access closes at the deadline. Restarting preserves purchases and deliveries.",
  },
];

export async function requestOperation(baseUrl, name, input, role = "server") {
  const spec = operation(name);
  const url = new URL(spec.path, baseUrl);
  if (spec.method === "GET" && input)
    for (const [key, value] of Object.entries(input))
      url.searchParams.set(key, value);
  const response = await fetch(url, {
    method: spec.method,
    headers: {
      "content-type": "application/json",
      ...(role ? { authorization: CREDENTIALS[role] } : {}),
    },
    ...(spec.method === "POST" ? { body: JSON.stringify(input) } : {}),
  });
  return {
    operation: name,
    httpStatus: response.status,
    body: await response.json(),
  };
}

export function createScenario(runtime) {
  const history = [];
  const checks = [];
  const evidence = { store: FIXTURE.store, evidence: FIXTURE.evidence };
  const call = (name, input, role) =>
    requestOperation(runtime.baseUrl, name, input, role);
  const check = (label, actual, expected) => {
    assert.deepEqual(actual, expected, label);
    checks.push(label);
  };

  async function advance() {
    const stage = history.length;
    if (stage >= STAGES.length) return history.at(-1);
    const responses = [];
    const run = async (name, input, role) => {
      const result = await call(name, input, role);
      responses.push(result);
      return result;
    };
    const start = checks.length;
    if (stage === 0) {
      check(
        "Fixture request matches the installed schema",
        validate(operation("verifyPurchase").input, evidence),
        true,
      );
      check(
        "Capabilities use the published response schema",
        (await run("providerCapabilities", null, null)).httpStatus,
        200,
      );
      check(
        "Purchase storage starts empty",
        runtime.provider.inspect().purchases,
        [],
      );
      check(
        "No profile conformance is claimed",
        (await run("providerCapabilities", null, null)).body.profiles,
        undefined,
      );
    } else if (stage === 1) {
      check(
        "Fixture evidence is accepted",
        (await run("verifyPurchase", evidence, "verification")).body.isValid,
        true,
      );
      check(
        "Verification does not grant access",
        (await run("entitlements", { userId: FIXTURE.userId })).body.productIds,
        [],
      );
      check(
        "Invalid evidence produces a negative verdict",
        (
          await run(
            "verifyPurchase",
            { store: FIXTURE.store, evidence: "invalid" },
            "verification",
          )
        ).body.isValid,
        false,
      );
      check(
        "An upstream outage is not a negative verdict",
        (
          await run(
            "verifyPurchase",
            { store: FIXTURE.store, evidence: "local-upstream-outage" },
            "verification",
          )
        ).body.error.code,
        "VERIFICATION_FAILED",
      );
    } else if (stage === 2) {
      check(
        "Verification credentials cannot bind a user",
        (
          await run(
            "bindPurchase",
            { ...evidence, userId: FIXTURE.userId },
            "verification",
          )
        ).body.error.code,
        "FORBIDDEN",
      );
      check(
        "The server binds Alice",
        (await run("bindPurchase", { ...evidence, userId: FIXTURE.userId }))
          .body.bound,
        true,
      );
      check(
        "Repeating the same binding succeeds",
        (await run("bindPurchase", { ...evidence, userId: FIXTURE.userId }))
          .body.bound,
        true,
      );
      check(
        "Bob cannot take Alice's purchase",
        (await run("bindPurchase", { ...evidence, userId: "demo_bob" })).body
          .bound,
        false,
      );
      check(
        "Alice can access Premium",
        (await run("entitlements", { userId: FIXTURE.userId })).body.productIds,
        [FIXTURE.productId],
      );
      check(
        "First binding queues one grant; repeat and conflict queue none",
        runtime.provider.inspect().deliveries.map((row) => row.eventType),
        ["entitlement.granted"],
      );
    } else if (stage === 3) {
      runtime.time = FIXTURE.startsAt + 86_400_000;
      runtime.provider.observe({
        id: "fixture-cancel",
        kind: "cancel",
        occurredAt: runtime.time,
      });
      const result = await run("subscriptionStatus", {
        userId: FIXTURE.userId,
      });
      check("Cancellation keeps paid access", result.body.active, true);
      check(
        "Cancellation stops renewal",
        result.body.subscription.willRenew,
        false,
      );
      check(
        "Cancellation queues one event",
        runtime.provider
          .inspect()
          .deliveries.filter((row) => row.eventType === "subscription.canceled")
          .length,
        1,
      );
    } else if (stage === 4) {
      const failed = await deliver(
        runtime.provider,
        runtime.secret,
        runtime.now,
        async () => new Response(null, { status: 503 }),
      );
      responses.push({
        operation: "webhook: receiver unavailable",
        body: failed,
      });
      check("A 503 leaves a durable retry", failed[0].status, "pending");
      runtime.restart();
      runtime.time += 30_000;
      const delivered = await deliver(
        runtime.provider,
        runtime.secret,
        runtime.now,
        runtime.post,
      );
      responses.push({
        operation: "webhook: retry after restart",
        body: delivered,
      });
      check("Retry survives provider restart", delivered[0].httpStatus, 200);
      check(
        "Retry keeps the delivery identity",
        delivered[0].deliveryId,
        failed[0].deliveryId,
      );
      // Simulate loss of the delivery acknowledgement after the receiver committed.
      runtime.provider.db
        .query("UPDATE outbox SET status = 'pending', next_at = 0")
        .run();
      runtime.time += 1_000;
      responses.push({
        operation: "webhook: lost-ack redelivery",
        body: await deliver(
          runtime.provider,
          runtime.secret,
          runtime.now,
          runtime.post,
        ),
      });
      check(
        "Redelivery has one inbox row per event",
        runtime.receiver.count(),
        2,
      );
    } else if (stage === 5) {
      runtime.time = FIXTURE.expiresAt;
      check(
        "Access closes at expiry before a notification arrives",
        (await run("entitlements", { userId: FIXTURE.userId })).body.productIds,
        [],
      );
      const observation = {
        id: "fixture-expire",
        kind: "expire",
        occurredAt: runtime.time,
      };
      runtime.provider.observe(observation);
      check(
        "Duplicate store notification emits no extra event",
        runtime.provider.observe(observation),
        false,
      );
      const before = runtime.provider.inspect();
      runtime.restart();
      check(
        "Reopening both databases preserves state",
        runtime.provider.inspect(),
        before,
      );
      check(
        "Receiver deduplication survives restart",
        runtime.receiver.count(),
        2,
      );
      responses.push({
        operation: "webhook: expiry + revocation",
        body: await deliver(
          runtime.provider,
          runtime.secret,
          runtime.now,
          runtime.post,
        ),
      });
      check("All four events reach the receiver", runtime.receiver.count(), 4);
      check(
        "The final status is inactive",
        (await run("subscriptionStatus", { userId: FIXTURE.userId })).body
          .active,
        false,
      );
    }
    const entry = {
      step: stage + 1,
      ...STAGES[stage],
      simulatedTime: new Date(runtime.time).toISOString(),
      ...runtime.provider.inspect(),
      inboxCount: runtime.receiver.count(),
      responses,
      checks: checks.slice(start),
      totalChecks: checks.length,
    };
    history.push(entry);
    return entry;
  }

  return { advance, history };
}
