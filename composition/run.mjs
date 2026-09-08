import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { WEBHOOK, HTTP_BINDING } from "openiap-commerce-protocol";
import { createProvider, FIXTURE, CREDENTIALS } from "../provider.mjs";
import { createReceiver, deliver, sign } from "../webhooks.mjs";
import { createCommerceClient } from "./commerce-client.mjs";
import { createMemoryProvider } from "./memory-provider.mjs";
import { createPurchaseFlow } from "./purchase-flow.mjs";

export const COMPOSITION_SOURCES = [
  "composition/commerce-client.mjs",
  "composition/memory-provider.mjs",
  "composition/purchase-flow.mjs",
  "composition/run.mjs",
  "composition/README.md",
  "contract.mjs",
  "provider.mjs",
  "webhooks.mjs",
  "package.json",
  "package-lock.json",
];
const root = new URL("../", import.meta.url);
export const sourceHashes = () =>
  Object.fromEntries(
    COMPOSITION_SOURCES.map((name) => [
      name,
      createHash("sha256")
        .update(readFileSync(new URL(name, root)))
        .digest("hex"),
    ]),
  );

export async function runComposition() {
  const initialHashes = sourceHashes();
  const directory = mkdtempSync(join(tmpdir(), "commerce-composition-"));
  const servers = [],
    receivers = [];
  const checks = [],
    results = [],
    traces = [];
  const check = (name, actual, expected) => {
    assert.deepEqual(actual, expected, name);
    checks.push(name);
  };
  let time = FIXTURE.startsAt;
  const now = () => time;
  const sqlite = createProvider(join(directory, "provider.sqlite"), now);
  const memoryCredential = `Bearer fixture-${randomBytes(16).toString("hex")}`;
  const memory = createMemoryProvider({
    fixture: FIXTURE,
    credential: memoryCredential,
    now,
  });
  const evidence = { store: FIXTURE.store, evidence: FIXTURE.evidence };
  const serve = (fetch) => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      maxRequestBodySize: 65536,
      fetch,
    });
    servers.push(server);
    return `http://127.0.0.1:${server.port}`;
  };
  const providers = [
    {
      id: "sqlite",
      label: "SQLite provider",
      source: "provider.mjs",
      fetch: sqlite.fetch,
      credential: CREDENTIALS.server,
      observe: (kind) =>
        sqlite.observe({ id: randomUUID(), kind, occurredAt: now() }),
      events: () =>
        sqlite.db
          .query("SELECT body FROM outbox ORDER BY rowid")
          .all()
          .map((row) => JSON.parse(row.body)),
      signed: (event, secret) => {
        const body = JSON.stringify(event),
          timestamp = String(Math.floor(now() / 1000));
        return {
          body,
          headers: {
            "content-type": WEBHOOK.contentType,
            [WEBHOOK.timestampHeader]: timestamp,
            [WEBHOOK.signatureHeader]: sign(secret, timestamp, body),
            [WEBHOOK.eventIdHeader]: event.eventId,
          },
        };
      },
      flush: (url, secret) =>
        deliver(sqlite, secret, now, (init) =>
          fetch(url, {
            ...init,
            redirect: "error",
            signal: AbortSignal.timeout(5000),
          }),
        ),
    },
    {
      id: "memory",
      label: "Memory provider",
      source: "composition/memory-provider.mjs",
      fetch: memory.fetch,
      credential: memoryCredential,
      observe: memory.observe,
      events: memory.events,
      signed: memory.signed,
      flush: memory.flush,
    },
  ];
  try {
    for (const provider of providers) {
      provider.baseUrl = serve(async (request) => {
        const response = await provider.fetch(request);
        traces.push({
          provider: provider.id,
          method: request.method,
          path: new URL(request.url).pathname,
          status: response.status,
        });
        return response;
      });
      provider.client = createCommerceClient(provider);
      provider.secret = randomBytes(32).toString("hex");
      provider.inboxPath = join(directory, `${provider.id}-inbox.sqlite`);
      provider.receiver = createReceiver(
        provider.inboxPath,
        provider.secret,
        now,
      );
      receivers.push(provider.receiver);
      provider.failures = 1;
      provider.receiverUrl = serve((request) => {
        if (provider.failures-- > 0)
          return new Response("Try again", { status: 503 });
        return provider.receiver.fetch(request);
      });
      const descriptor = await provider.client.call("providerCapabilities");
      check(
        `${provider.id}: contract major matches`,
        descriptor.specVersion.split(".")[0],
        HTTP_BINDING.protocolVersion.split(".")[0],
      );
      check(
        `${provider.id}: no unearned profile claim`,
        descriptor.profiles,
        undefined,
      );
      const before = await provider.client.call("entitlements", {
        userId: FIXTURE.userId,
      });
      check(
        `${provider.id}: no access before verification`,
        before.productIds,
        [],
      );
      check(
        `${provider.id}: rejected evidence stays a verdict`,
        (
          await provider.client.call("verifyPurchase", {
            ...evidence,
            evidence: "not-a-purchase",
          })
        ).isValid,
        false,
      );
      await assert.rejects(
        () =>
          provider.client.call("verifyPurchase", {
            ...evidence,
            evidence: "local-upstream-outage",
          }),
        /operation failed/,
      );
      checks.push(`${provider.id}: verifier outage stays an operation failure`);
      await assert.rejects(
        () =>
          provider.client.fulfill(
            { ...evidence, evidence: "not-a-purchase" },
            { userId: FIXTURE.userId, productId: FIXTURE.productId },
          ),
        /not accepted/,
      );
      checks.push(`${provider.id}: rejected verification cannot fulfill`);
      check(
        `${provider.id}: accepts fixture evidence`,
        (await provider.client.call("verifyPurchase", evidence)).isValid,
        true,
      );
      check(
        `${provider.id}: verification alone grants no access`,
        (await provider.client.call("entitlements", { userId: FIXTURE.userId }))
          .productIds,
        [],
      );

      const order = [];
      const flow = createPurchaseFlow({
        purchase: async (productId) => {
          check(
            `${provider.id}: selected product reaches purchase callback`,
            productId,
            FIXTURE.productId,
          );
          order.push("purchase");
          return {
            status: "purchased",
            evidence: { ...evidence, userId: "untrusted_bob" },
          };
        },
        fulfill: async (input, productId) => {
          order.push("fulfill");
          return provider.client.fulfill(input, {
            userId: FIXTURE.userId,
            productId,
          });
        },
        finish: async () => {
          order.push("finish");
        },
      });
      check(
        `${provider.id}: paywall selection completes`,
        (await flow(FIXTURE.productId)).status,
        "fulfilled",
      );
      check(`${provider.id}: fulfillment precedes finishing`, order, [
        "purchase",
        "fulfill",
        "finish",
      ]);
      const bound = await provider.client.call("entitlements", {
        userId: FIXTURE.userId,
      });
      check(`${provider.id}: trusted user receives Premium`, bound.productIds, [
        FIXTURE.productId,
      ]);
      check(
        `${provider.id}: client identity is ignored`,
        (
          await provider.client.call("entitlements", {
            userId: "untrusted_bob",
          })
        ).productIds,
        [],
      );
      check(
        `${provider.id}: another user cannot take ownership`,
        (
          await provider.client.call("bindPurchase", {
            ...evidence,
            userId: "other_user",
          })
        ).bound,
        false,
      );
      const again = await provider.client.fulfill(evidence, {
        userId: FIXTURE.userId,
        productId: FIXTURE.productId,
      });
      check(
        `${provider.id}: repeated fulfillment returns the same access`,
        again,
        bound,
      );
      provider.observe("cancel");
      const canceled = await provider.client.call("subscriptionStatus", {
        userId: FIXTURE.userId,
      });
      check(
        `${provider.id}: cancellation preserves paid time`,
        [canceled.active, canceled.subscription.willRenew],
        [true, false],
      );
      const firstDelivery = await provider.flush(
        provider.receiverUrl,
        provider.secret,
      );
      check(
        `${provider.id}: temporary receiver failure is queued for retry`,
        firstDelivery[0].status,
        "pending",
      );
      provider.result = {
        id: provider.id,
        label: provider.label,
        source: provider.source,
        before,
        bound,
        canceled,
      };
    }

    time += 30000;
    for (const provider of providers) {
      const retries = await provider.flush(
        provider.receiverUrl,
        provider.secret,
      );
      check(
        `${provider.id}: retry succeeds over HTTP`,
        retries.map((row) => [row.httpStatus, row.attempt]),
        [[200, 2]],
      );
      check(
        `${provider.id}: one inbox effect per event`,
        provider.receiver.count(),
        2,
      );
      const event = provider.events()[0];
      const request = provider.signed(event, provider.secret);
      const repeat = await fetch(provider.receiverUrl, {
        method: "POST",
        ...request,
      });
      check(
        `${provider.id}: redelivery is a duplicate`,
        (await repeat.json()).duplicate,
        true,
      );
      check(
        `${provider.id}: modified body fails authentication`,
        (
          await fetch(provider.receiverUrl, {
            method: "POST",
            ...request,
            body: request.body + " ",
          })
        ).status,
        401,
      );
      const wrongKey = provider.signed(
        event,
        providers.find((other) => other !== provider).secret,
      );
      check(
        `${provider.id}: another emitter's key is rejected`,
        (await fetch(provider.receiverUrl, { method: "POST", ...wrongKey }))
          .status,
        401,
      );

      const extension = {
        ...event,
        eventId: "same-id-in-each-emitter",
        extensions: { "partner.segment": "demo" },
      };
      const extended = provider.signed(extension, provider.secret);
      check(
        `${provider.id}: optional extension is accepted`,
        (await fetch(provider.receiverUrl, { method: "POST", ...extended }))
          .status,
        200,
      );
      check(
        `${provider.id}: equal IDs in different emitter inboxes are not lost`,
        provider.receiver.count(),
        3,
      );
      const invalidExtension = provider.signed(
        {
          ...event,
          eventId: "invalid-extension",
          extensions: { partner: { segment: "demo" } },
        },
        provider.secret,
      );
      check(
        `${provider.id}: an extension violating the contract is rejected`,
        (
          await fetch(provider.receiverUrl, {
            method: "POST",
            ...invalidExtension,
          })
        ).status,
        400,
      );
      const stored = provider.receiver
        .inspect()
        .find(
          (event) =>
            event.eventId === extension.eventId &&
            event.projectId === extension.projectId,
        );
      check(
        `${provider.id}: extension bytes survive storage`,
        stored?.extensions,
        extension.extensions,
      );
    }

    time = FIXTURE.expiresAt;
    for (const provider of providers) {
      check(
        `${provider.id}: read closes access at the deadline before a notification`,
        (await provider.client.call("entitlements", { userId: FIXTURE.userId }))
          .productIds,
        [],
      );
      provider.observe("expire");
      provider.result.expired = await provider.client.call(
        "subscriptionStatus",
        { userId: FIXTURE.userId },
      );
      check(
        `${provider.id}: expired status is inactive`,
        provider.result.expired.active,
        false,
      );
      await provider.flush(provider.receiverUrl, provider.secret);
      check(
        `${provider.id}: lifecycle and grant events match`,
        provider.events().map((event) => event.eventType),
        [
          "entitlement.granted",
          "subscription.canceled",
          "subscription.expired",
          "entitlement.revoked",
        ],
      );
      check(
        `${provider.id}: all emitted events were persisted`,
        provider.receiver.count(),
        5,
      );
      const wrong = createCommerceClient({
        ...provider,
        credential: "Bearer invalid-fixture-key",
      });
      await assert.rejects(
        () => wrong.call("entitlements", { userId: FIXTURE.userId }),
        /operation failed/,
      );
      checks.push(`${provider.id}: wrong caller credentials fail closed`);
      results.push(provider.result);
    }
    for (const state of ["before", "bound", "canceled", "expired"])
      check(
        `same consumer observes equal ${state} results across providers`,
        results[0][state],
        results[1][state],
      );

    for (const status of ["pending", "canceled", "failed"]) {
      let effects = 0;
      const flow = createPurchaseFlow({
        purchase: async () => ({ status }),
        fulfill: async () => {
          effects++;
        },
        finish: async () => {
          effects++;
        },
      });
      check(
        `host: ${status} is shown without fulfillment or finishing`,
        [(await flow(FIXTURE.productId)).status, effects],
        [status, 0],
      );
    }
    let releasePurchase;
    const blocked = new Promise((resolve) => {
      releasePurchase = resolve;
    });
    const busyFlow = createPurchaseFlow({
      purchase: async () => {
        await blocked;
        return { status: "canceled" };
      },
      fulfill: async () => {
        throw new Error("Unexpected fulfillment");
      },
      finish: async () => {
        throw new Error("Unexpected finish");
      },
    });
    const inProgress = busyFlow(FIXTURE.productId);
    check(
      "host: repeated selection does not start another purchase",
      (await busyFlow(FIXTURE.productId)).status,
      "busy",
    );
    releasePurchase();
    await inProgress;
    check(
      "host: selection becomes available after cancellation",
      (await busyFlow(FIXTURE.productId)).status,
      "canceled",
    );
    let finished = false;
    const failedBackend = createPurchaseFlow({
      purchase: async () => ({ status: "purchased", evidence }),
      fulfill: async () => {
        throw new Error("Backend unavailable");
      },
      finish: async () => {
        finished = true;
      },
    });
    check(
      "host: backend failure does not finish a purchase",
      [(await failedBackend(FIXTURE.productId)).status, finished],
      ["failed", false],
    );
    const failedFinish = createPurchaseFlow({
      purchase: async () => ({ status: "purchased", evidence }),
      fulfill: async () => ({ productIds: [FIXTURE.productId] }),
      finish: async () => {
        throw new Error("Finish unavailable");
      },
    });
    check(
      "host: a finish failure preserves confirmed access",
      await failedFinish(FIXTURE.productId),
      { status: "finish-pending", access: { productIds: [FIXTURE.productId] } },
    );
    const malformedUrl = serve(() =>
      Response.json({
        userId: FIXTURE.userId,
        productIds: [FIXTURE.productId],
      }),
    );
    await assert.rejects(
      () =>
        createCommerceClient({
          baseUrl: malformedUrl,
          credential: "fixture",
        }).call("entitlements", { userId: FIXTURE.userId }),
      /Invalid operation result/,
    );
    checks.push("client: a malformed success response is rejected over HTTP");
    check(
      "consumer and provider source files stay unchanged throughout the run",
      sourceHashes(),
      initialHashes,
    );
    return {
      recordedAt: new Date().toISOString(),
      scope:
        "Two separately implemented fixture providers and two scoped receivers over loopback HTTP in one Bun process. One backend client and receiver implementation, unchanged across both configurations. Host purchase callbacks are simulated.",
      limits: [
        "Same project authorship; no independent organization validation.",
        "No store purchase, SDK/device checkout, complete profile conformance, or production deployment.",
        "SQLite versus in-memory state is tested on fresh stores, not a historical-data migration.",
        "One trusted emitter/project and secret per receiver database; no cross-provider deduplication claim.",
      ],
      protocolVersion: HTTP_BINDING.protocolVersion,
      sourceHashes: initialHashes,
      configurationChanges: [
        "Provider URL",
        "Server credential",
        "Emitter endpoint, signing secret, and isolated inbox database",
      ],
      checks,
      results,
      traces,
    };
  } finally {
    await Promise.all(servers.map((server) => server.stop(true)));
    for (const receiver of receivers) receiver.close();
    sqlite.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const report = await runComposition();
  if (process.argv[2] === "--record") {
    assert(process.argv[3], "Provide the report filename");
    writeFileSync(
      resolve(process.argv[3]),
      JSON.stringify(report, null, 2) + "\n",
    );
  }
  console.log(
    `Composition: ${report.checks.length} checks passed; same client and receiver source across two fixture providers. No store or production service contacted.`,
  );
}
