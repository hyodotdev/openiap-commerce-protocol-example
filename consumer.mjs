import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { WEBHOOK, COMMERCE_EVENT_VERSION } from "openiap-commerce-protocol";
import { createReceiver, sign } from "./webhooks.mjs";
import { validate } from "./contract.mjs";

// One configured emitter/project and signing key per receiver database.
export function startConsumer({ secret, path, port = 0, now = Date.now }) {
  assert(secret, "Set COMMERCE_WEBHOOK_SECRET to the provider signing secret.");
  let receiver = createReceiver(path, secret, now);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    maxRequestBodySize: 64 * 1024,
    fetch(request) {
      const url = new URL(request.url);
      if (request.method === "POST" && url.pathname === "/webhooks/commerce")
        return receiver.fetch(request);
      if (request.method === "GET" && url.pathname === "/health")
        return Response.json({ ready: true });
      return new Response("Not found", { status: 404 });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}/webhooks/commerce`,
    count: () => receiver.count(),
    reopen() {
      receiver.close();
      receiver = createReceiver(path, secret, now);
    },
    async close() {
      await server.stop(true);
      receiver.close();
    },
  };
}

export async function runConsumerDemo() {
  const directory = mkdtempSync(join(tmpdir(), "commerce-consumer-"));
  const secret = randomBytes(32).toString("hex");
  const now = Date.now();
  const consumer = startConsumer({
    secret,
    path: join(directory, "inbox.sqlite"),
    now: () => now,
  });
  const checks = [],
    results = [];
  const check = (name, actual, expected) => {
    assert.deepEqual(actual, expected, name);
    checks.push(name);
  };
  const lifecycle = [
    ["subscription.started", "Active", true],
    ["entitlement.granted", "Active", true],
    ["subscription.renewed", "Active", true],
    ["subscription.canceled", "Active", true],
    ["subscription.expired", "Expired", false],
    ["entitlement.revoked", "Expired", false],
    ["subscription.refunded", "Refunded", false],
  ];
  try {
    const health = await fetch(new URL("/health", consumer.url), {
      headers: { host: "receiver.example.test" },
    });
    check("Health accepts the proxy public Host header", health.status, 200);
    for (const [index, [eventType, state, active]] of lifecycle.entries()) {
      const event = {
        eventId: randomUUID(),
        eventType,
        eventVersion: COMMERCE_EVENT_VERSION,
        occurredAt: now - 60_000 + index * 1000,
        processedAt: now,
        store: "fixture",
        environment: "local-fixture",
        projectId: "demo_project",
        userId: "demo_user",
        productId: "premium.monthly",
        ...(["subscription.started", "subscription.renewed"].includes(eventType)
          ? {
              price: {
                currency: "USD",
                amountMicros: 9990000,
                provenance: "store",
              },
            }
          : {}),
        subscription: {
          productId: "premium.monthly",
          state,
          active,
          expiresAt: active ? now + 60_000 : now - 1000,
          willRenew: active && eventType !== "subscription.canceled",
        },
      };
      assert(validate("#/$defs/CommerceEvent", event));
      const body = JSON.stringify(event);
      const timestamp = String(Math.floor(now / 1000));
      const headers = {
        host: "receiver.example.test",
        "content-type": WEBHOOK.contentType,
        [WEBHOOK.timestampHeader]: timestamp,
        [WEBHOOK.signatureHeader]: sign(secret, timestamp, body),
        [WEBHOOK.eventIdHeader]: event.eventId,
        [WEBHOOK.deliveryIdHeader]: randomUUID(),
      };
      const response = await fetch(consumer.url, {
        method: "POST",
        headers,
        body,
      });
      const result = await response.json();
      check(
        `${eventType}: authenticated and saved`,
        [response.status, result.duplicate],
        [200, false],
      );
      const duplicate = await fetch(consumer.url, {
        method: "POST",
        headers,
        body,
      });
      const duplicateResult = await duplicate.json();
      check(
        `${eventType}: redelivery deduplicated`,
        [duplicate.status, duplicateResult.duplicate],
        [200, true],
      );
      const tampered = await fetch(consumer.url, {
        method: "POST",
        headers,
        body: body + " ",
      });
      check(`${eventType}: tampering rejected`, tampered.status, 401);
      results.push({
        event,
        httpStatus: response.status,
        duplicate: duplicateResult.duplicate,
        requestHost: headers.host,
        tamperedHttpStatus: tampered.status,
      });
    }
    check("One inbox record per event", consumer.count(), lifecycle.length);
    consumer.reopen();
    check(
      "Inbox survives reopening SQLite",
      consumer.count(),
      lifecycle.length,
    );
    return {
      recordedAt: new Date().toISOString(),
      scope:
        "Real loopback HTTP, signature validation and durable deduplication. Fictional lifecycle samples; no provider or store contacted. One emitter/project per receiver database. No business or revenue calculation.",
      checks,
      results,
      inboxCount: consumer.count(),
    };
  } finally {
    await consumer.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  if (process.argv[2] === "demo") {
    const report = await runConsumerDemo();
    if (process.argv[3] === "--record") {
      assert(process.argv[4], "Provide a report path");
      report.sourceHashes = Object.fromEntries(
        [
          "consumer.mjs",
          "webhooks.mjs",
          "contract.mjs",
          "package.json",
          "package-lock.json",
        ].map((name) => [
          name,
          createHash("sha256")
            .update(readFileSync(join(import.meta.dir, name)))
            .digest("hex"),
        ]),
      );
      writeFileSync(
        resolve(process.argv[4]),
        JSON.stringify(report, null, 2) + "\n",
      );
    }
    console.log(
      `Receiver ready: ${report.inboxCount} events saved once; ${report.checks.length} checks passed. No external service contacted.`,
    );
  } else {
    const consumer = startConsumer({
      secret: process.env.COMMERCE_WEBHOOK_SECRET,
      path: resolve(process.env.COMMERCE_INBOX_PATH ?? "consumer.sqlite"),
      port: 5182,
    });
    console.log(
      `Receiver: ${consumer.url}\nPersisted inbox: ${resolve(process.env.COMMERCE_INBOX_PATH ?? "consumer.sqlite")}`,
    );
    for (const signal of ["SIGINT", "SIGTERM"])
      process.on(signal, async () => {
        await consumer.close();
        process.exit(0);
      });
  }
}
