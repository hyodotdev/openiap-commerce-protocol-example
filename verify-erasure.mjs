import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { startLab } from "./server.mjs";
import { FIXTURE } from "./provider.mjs";
import { requestOperation, STAGES } from "./scenario.mjs";
import { deliver, sign } from "./webhooks.mjs";
import { WEBHOOK } from "openiap-commerce-protocol";

export async function verifyErasure() {
  const checks = [];
  const check = (name, actual, expected) => {
    assert.deepEqual(actual, expected, name);
    checks.push(name);
  };
  const lab = startLab();
  try {
    const { runtime } = lab;
    const call = (name, input, role) =>
      requestOperation(runtime.baseUrl, name, input, role);
    const evidence = { store: FIXTURE.store, evidence: FIXTURE.evidence };
    await call("verifyPurchase", evidence);
    await call("bindPurchase", { ...evidence, userId: FIXTURE.userId });
    const pending = runtime.provider.db
      .query("SELECT body FROM outbox LIMIT 1")
      .get().body;
    const post = (body) => {
      const timestamp = String(Math.floor(runtime.now() / 1000));
      return runtime.post({
        method: "POST",
        body,
        headers: {
          [WEBHOOK.timestampHeader]: timestamp,
          [WEBHOOK.signatureHeader]: sign(runtime.secret, timestamp, body),
          [WEBHOOK.eventIdHeader]: JSON.parse(body).eventId,
        },
      });
    };
    await post(pending);
    check(
      "An active purchase has a delivered event copy",
      runtime.receiver.count(),
      1,
    );
    runtime.receiver.eraseUser(FIXTURE.userId);
    let erased;
    await deliver(
      runtime.provider,
      runtime.secret,
      runtime.now,
      async (init) => {
        erased = await call("eraseUser", { userId: FIXTURE.userId });
        return runtime.post(init);
      },
    );
    check("Erasure during delivery completes", erased.body.status, "completed");
    check(
      "An in-flight event cannot resurrect receiver data",
      runtime.receiver.count(),
      0,
    );
    check(
      "An in-flight acknowledgement cannot resurrect the outbox",
      runtime.provider.inspect().deliveries,
      [],
    );
    runtime.restart();
    check(
      "Repeated erase survives restart",
      (await call("eraseUser", { userId: FIXTURE.userId })).body,
      erased.body,
    );
    check(
      "An old signed event remains discarded after restart",
      (await (await post(pending)).json()).discarded,
      "erased-user",
    );
    const late = JSON.stringify({
      ...JSON.parse(pending),
      eventId: "late-new-event",
    });
    check(
      "A new event ID cannot bypass erasure",
      (await (await post(late)).json()).discarded,
      "erased-user",
    );
    check(
      "Verification cannot bind an erased purchase",
      (await call("verifyPurchase", evidence)).body.isValid,
      true,
    );
    check(
      "Stale binding cannot restore an erased account",
      (await call("bindPurchase", { ...evidence, userId: FIXTURE.userId })).body
        .bound,
      false,
    );
    check(
      "Another account cannot claim erased evidence",
      (await call("bindPurchase", { ...evidence, userId: "demo_bob" })).body
        .bound,
      false,
    );
    check(
      "Erased account is inactive before paid expiry",
      (await call("subscriptionStatus", { userId: FIXTURE.userId })).body,
      { active: false },
    );
    runtime.time = FIXTURE.expiresAt;
    runtime.provider.observe({
      id: "expiry-after-deletion",
      kind: "expire",
      occurredAt: runtime.time,
    });
    await deliver(runtime.provider, runtime.secret, runtime.now, runtime.post);
    check(
      "Late lifecycle processing carries no erased identity",
      runtime.receiver.inspect().map((event) => event.userId),
      [undefined],
    );
    const serialized = JSON.stringify([
      runtime.provider.db.query("SELECT * FROM purchases").all(),
      runtime.provider.db.query("SELECT * FROM outbox").all(),
      runtime.provider.db.query("SELECT * FROM erased_users").all(),
      runtime.receiver.inspect(),
    ]);
    check(
      "Persisted protocol records contain no erased user ID",
      serialized.includes(FIXTURE.userId),
      false,
    );
    check(
      "Unknown-user erasure is accepted",
      (await call("eraseUser", { userId: "missing_user" })).body.accepted,
      true,
    );
  } finally {
    await lab.close();
    rmSync(lab.directory, { recursive: true, force: true });
  }
  const walkthrough = startLab();
  try {
    for (let i = 0; i < STAGES.length; i++)
      await walkthrough.scenario.advance();
    checks.push(...walkthrough.scenario.history.at(-1).checks);
  } finally {
    await walkthrough.close();
    rmSync(walkthrough.directory, { recursive: true, force: true });
  }
  return checks;
}

if (import.meta.main)
  console.log(`${(await verifyErasure()).length} erasure checks passed.`);
