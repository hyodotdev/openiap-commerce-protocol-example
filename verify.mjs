import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import vectors from "openiap-commerce-protocol/vectors/signatures.json";
import { SUBSCRIPTION_STATES, WEBHOOK } from "openiap-commerce-protocol";
import { FIXTURE, isEntitled } from "./provider.mjs";
import { requestOperation } from "./scenario.mjs";
import { runConsumerDemo } from "./consumer.mjs";
import { runBridgeDemo } from "./client-bridge.mjs";
import { startLab } from "./server.mjs";
import { authentic, deliver, sign } from "./webhooks.mjs";

export async function verifyLab({ compareSigner } = {}) {
  const lab = startLab();
  const checks = [];
  const check = (label, actual, expected) => {
    assert.deepEqual(actual, expected, label);
    checks.push(label);
  };
  try {
    for (let i = 0; i < 6; i++) await lab.scenario.advance();
    checks.push(...lab.scenario.history.flatMap((entry) => entry.checks));
    for (const vector of vectors.cases) {
      const signature = sign(vector.secret, vector.timestamp, vector.body);
      const expected = vector.previousSecret
        ? `${signature},${sign(vector.previousSecret, vector.timestamp, vector.body)}`
        : signature;
      check(`Signature vector: ${vector.name}`, expected, vector.expected);
      if (compareSigner) {
        check(
          `IAPKit signs the same bytes: ${vector.name}`,
          signature,
          await compareSigner(vector.secret, vector.timestamp, vector.body),
        );
      }
      check(
        `Receiver accepts vector: ${vector.name}`,
        authentic(
          [vector.secret],
          String(vector.timestamp),
          vector.body,
          vector.presentedHeader ?? expected,
          vector.timestamp,
        ),
        true,
      );
    }
    for (const vector of vectors.rejections) {
      check(
        `Receiver rejects: ${vector.name}`,
        authentic(
          [vector.secret],
          String(vector.timestamp),
          vector.body,
          vector.presentedSignature,
          vector.receiverNow ?? vector.timestamp,
        ),
        false,
      );
    }
    for (const state of [...SUBSCRIPTION_STATES, "FutureState"]) {
      const eligible = state === "Active" || state === "InGracePeriod";
      check(`${state}: before expiry`, isEntitled(state, 100, 99), eligible);
      check(`${state}: at expiry`, isEntitled(state, 100, 100), false);
      check(
        `${state}: no deadline`,
        isEntitled(state, undefined, 100),
        eligible,
      );
    }
    const call = (name, input, role) =>
      requestOperation(lab.runtime.baseUrl, name, input, role);
    check(
      "Missing credentials are refused",
      (await call("entitlements", { userId: FIXTURE.userId }, null)).httpStatus,
      401,
    );
    check(
      "Verification role cannot enumerate users",
      (await call("entitlements", { userId: FIXTURE.userId }, "verification"))
        .httpStatus,
      403,
    );
    check(
      "Malformed input is refused",
      (await call("bindPurchase", { store: FIXTURE.store })).httpStatus,
      400,
    );
    check(
      "A real store is not falsely accepted",
      (
        await call("verifyPurchase", {
          store: "google",
          google: { purchaseToken: "fixture" },
        })
      ).body.error.code,
      "UNSUPPORTED_STORE",
    );
    check(
      "Erasure is explicitly unimplemented",
      (await call("eraseUser", { userId: FIXTURE.userId })).body.error.code,
      "UNSUPPORTED_PROFILE",
    );
    check(
      "Cancellation after expiry is ignored",
      lab.runtime.provider.observe({
        id: "late-cancel",
        kind: "cancel",
        occurredAt: FIXTURE.startsAt + 1000,
      }),
      false,
    );
    const expiredVerdict = await call("verifyPurchase", {
      store: FIXTURE.store,
      evidence: FIXTURE.evidence,
    });
    check(
      "Expired fixture evidence has an expired verdict",
      [expiredVerdict.body.isValid, expiredVerdict.body.state],
      [false, "EXPIRED"],
    );
    const body = lab.runtime.provider.db
      .query("SELECT body FROM outbox LIMIT 1")
      .get().body;
    const timestamp = Math.floor(lab.runtime.time / 1000).toString();
    const invalid = await lab.runtime.receiver.fetch(
      new Request(`${lab.runtime.baseUrl}/demo/receiver`, {
        method: "POST",
        body: body + " ",
        headers: {
          [WEBHOOK.timestampHeader]: timestamp,
          [WEBHOOK.signatureHeader]: sign(lab.runtime.secret, timestamp, body),
        },
      }),
    );
    check("Tampered HTTP body has no inbox effect", invalid.status, 401);
    check(
      "Receiver still has exactly four events",
      lab.runtime.receiver.count(),
      4,
    );
    check(
      "Cross-origin demo mutations are refused",
      (
        await fetch(`${lab.runtime.baseUrl}/demo/advance`, {
          method: "POST",
          headers: { origin: "https://untrusted.example" },
        })
      ).status,
      403,
    );
  } finally {
    await lab.close();
    rmSync(lab.directory, { recursive: true, force: true });
  }

  const fresh = startLab();
  try {
    const call = (name, input) =>
      requestOperation(fresh.runtime.baseUrl, name, input);
    const evidence = { store: FIXTURE.store, evidence: FIXTURE.evidence };
    await call("verifyPurchase", evidence);
    const bindings = await Promise.all(
      ["alice", "bob"].map((userId) =>
        call("bindPurchase", { ...evidence, userId }),
      ),
    );
    check(
      "Overlapping HTTP ownership claims have one winner",
      bindings.filter((row) => row.body.bound).length,
      1,
    );
    check(
      "A cancellation older than the active row is ignored",
      fresh.runtime.provider.observe({
        id: "old-active-cancel",
        kind: "cancel",
        occurredAt: FIXTURE.startsAt - 1,
      }),
      false,
    );
    check(
      "Ignoring an old cancellation preserves renewal",
      fresh.runtime.provider.inspect().purchases[0].willRenew,
      1,
    );
    assert.throws(
      () =>
        fresh.runtime.provider.observe({
          id: "early-expiry",
          kind: "expire",
          occurredAt: FIXTURE.startsAt,
        }),
      /reconciliation/,
    );
    check(
      "Conflicting expiry is not consumed",
      fresh.runtime.provider.db
        .query(
          "SELECT COUNT(*) AS count FROM observations WHERE id = 'early-expiry'",
        )
        .get().count,
      0,
    );
    fresh.runtime.time += 1000;
    const observation = {
      id: "atomic-cancel",
      kind: "cancel",
      occurredAt: fresh.runtime.time,
    };
    fresh.runtime.provider.db.exec(
      "CREATE TRIGGER fail_outbox BEFORE INSERT ON outbox BEGIN SELECT RAISE(ABORT, 'injected disk failure'); END;",
    );
    assert.throws(() => fresh.runtime.provider.observe(observation));
    check(
      "Outbox failure rolls back subscription state",
      fresh.runtime.provider.inspect().purchases[0].willRenew,
      1,
    );
    fresh.runtime.provider.db.exec("DROP TRIGGER fail_outbox");
    check(
      "Failed transaction leaves the observation retryable",
      fresh.runtime.provider.observe(observation),
      true,
    );
    for (let attempt = 0; attempt < 3; attempt++) {
      fresh.runtime.time += 120_000;
      await deliver(
        fresh.runtime.provider,
        fresh.runtime.secret,
        fresh.runtime.now,
        async () => new Response(null, { status: 503 }),
      );
    }
    check(
      "Exhausted retries enter dead-letter",
      fresh.runtime.provider.inspect().deliveries[0].status,
      "dead-letter",
    );
  } finally {
    await fresh.close();
    rmSync(fresh.directory, { recursive: true, force: true });
  }
  const binding = startLab();
  try {
    const call = (name, input) =>
      requestOperation(binding.runtime.baseUrl, name, input);
    const evidence = { store: FIXTURE.store, evidence: FIXTURE.evidence };
    await call("verifyPurchase", evidence);
    binding.runtime.provider.db.exec(
      "CREATE TRIGGER fail_grant BEFORE INSERT ON outbox BEGIN SELECT RAISE(ABORT, 'injected disk failure'); END;",
    );
    check(
      "Grant failure rejects binding",
      (await call("bindPurchase", { ...evidence, userId: FIXTURE.userId }))
        .httpStatus,
      500,
    );
    check(
      "Grant failure rolls back ownership",
      binding.runtime.provider.inspect().purchases[0].userId,
      null,
    );
    binding.runtime.provider.db.exec("DROP TRIGGER fail_grant");
    binding.runtime.time = FIXTURE.expiresAt;
    check(
      "An expired purchase can be bound",
      (await call("bindPurchase", { ...evidence, userId: FIXTURE.userId })).body
        .bound,
      true,
    );
    check(
      "Binding expired evidence emits no grant",
      binding.runtime.provider.inspect().deliveries,
      [],
    );
  } finally {
    await binding.close();
    rmSync(binding.directory, { recursive: true, force: true });
  }
  const delayed = startLab();
  try {
    const call = (name, input) =>
      requestOperation(delayed.runtime.baseUrl, name, input);
    const evidence = { store: FIXTURE.store, evidence: FIXTURE.evidence };
    await call("verifyPurchase", evidence);
    delayed.runtime.time += 3_600_000;
    await call("bindPurchase", { ...evidence, userId: FIXTURE.userId });
    const grant = JSON.parse(
      delayed.runtime.provider.db.query("SELECT body FROM outbox LIMIT 1").get()
        .body,
    );
    check(
      "Delayed binding retains the store occurrence",
      grant.occurredAt,
      FIXTURE.startsAt,
    );
    check(
      "Delayed binding records its actual processing time",
      grant.processedAt,
      delayed.runtime.time,
    );
    delayed.runtime.restart();
    delayed.runtime.time = FIXTURE.expiresAt + 60_000;
    delayed.runtime.provider.observe({
      id: "late-expiry",
      kind: "expire",
      occurredAt: delayed.runtime.time,
    });
    check(
      "Late expiry revokes a persisted grant exactly once",
      delayed.runtime.provider.inspect().deliveries.map((row) => row.eventType),
      ["entitlement.granted", "subscription.expired", "entitlement.revoked"],
    );
    delayed.runtime.provider.observe({
      id: "another-expiry",
      kind: "expire",
      occurredAt: delayed.runtime.time,
    });
    check(
      "Repeated expiry emits no second revocation",
      delayed.runtime.provider.inspect().deliveries.length,
      3,
    );
  } finally {
    await delayed.close();
    rmSync(delayed.directory, { recursive: true, force: true });
  }
  const equalTime = startLab();
  try {
    const call = (name, input) =>
      requestOperation(equalTime.runtime.baseUrl, name, input);
    const evidence = { store: FIXTURE.store, evidence: FIXTURE.evidence };
    await call("verifyPurchase", evidence);
    await call("bindPurchase", { ...evidence, userId: FIXTURE.userId });
    equalTime.runtime.time = FIXTURE.expiresAt;
    equalTime.runtime.provider.observe({
      id: "cancel-at-deadline",
      kind: "cancel",
      occurredAt: FIXTURE.expiresAt,
    });
    equalTime.runtime.provider.observe({
      id: "expire-at-deadline",
      kind: "expire",
      occurredAt: FIXTURE.expiresAt,
    });
    check(
      "Equal-time expiry retains its lifecycle transition",
      equalTime.runtime.provider.inspect().purchases[0].state,
      "Expired",
    );
    check(
      "Equal-time observations revoke once and preserve both transitions",
      equalTime.runtime.provider
        .inspect()
        .deliveries.map((row) => row.eventType),
      [
        "entitlement.granted",
        "subscription.canceled",
        "entitlement.revoked",
        "subscription.expired",
      ],
    );
  } finally {
    await equalTime.close();
    rmSync(equalTime.directory, { recursive: true, force: true });
  }
  checks.push(...(await runConsumerDemo()).checks);
  checks.push(...runBridgeDemo());
  return checks;
}

if (import.meta.main) {
  const checks = await verifyLab();
  console.log(
    `Commerce Protocol Example: ${checks.length} checks passed. No store or production service contacted.`,
  );
}
