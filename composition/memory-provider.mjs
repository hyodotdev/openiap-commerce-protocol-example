import { createHmac, randomUUID } from "node:crypto";
import {
  COMMERCE_EVENT_VERSION,
  HTTP_BINDING,
  WEBHOOK,
  providerCapabilitiesSchema,
} from "openiap-commerce-protocol";
import { operation, protocolError, validate } from "../contract.mjs";

// A second fixture implementation; it shares contract metadata, not SQLite logic.
export function createMemoryProvider({ fixture, credential, now }) {
  const purchases = new Map();
  const outbox = [];
  const supported = new Set([
    "initialValidation",
    "subscriptions",
    "entitlements",
    "serverNotifications",
    "expiration",
  ]);
  const capabilities = {
    specVersion: HTTP_BINDING.protocolVersion,
    implementation: {
      name: "Memory provider — separately implemented fixture",
    },
    eventTypes: [
      "entitlement.granted",
      "subscription.canceled",
      "subscription.expired",
      "entitlement.revoked",
    ],
    stores: {
      [fixture.store]: Object.fromEntries(
        Object.keys(
          providerCapabilitiesSchema.$defs.StoreCapabilities.properties,
        ).map((name) => [
          name,
          {
            provider: supported.has(name),
            implementation: supported.has(name),
            notes:
              "Fictional store only; no complete profile or production claim.",
          },
        ]),
      ),
    },
  };

  function snapshot(purchase) {
    return {
      store: fixture.store,
      productId: fixture.productId,
      state: purchase.expired ? "Expired" : "Active",
      active: !purchase.expired && now() < fixture.expiresAt,
      expiresAt: fixture.expiresAt,
      willRenew: purchase.renews,
    };
  }

  function emit(eventType, purchase) {
    const event = {
      eventId: randomUUID(),
      eventType,
      eventVersion: COMMERCE_EVENT_VERSION,
      occurredAt: now(),
      processedAt: now(),
      store: fixture.store,
      environment: "local-fixture",
      projectId: "memory_example",
      userId: purchase.owner,
      productId: fixture.productId,
      subscription: snapshot(purchase),
    };
    if (!validate("#/$defs/CommerceEvent", event))
      throw new Error("Invalid event");
    outbox.push({
      event,
      attempts: 0,
      status: "pending",
      nextAt: now(),
      deliveryId: randomUUID(),
    });
  }

  const handlers = {
    providerCapabilities: () => capabilities,
    verifyPurchase(input) {
      if (input.store !== fixture.store) return { error: "UNSUPPORTED_STORE" };
      if (typeof input.evidence !== "string")
        return { error: "INVALID_REQUEST" };
      if (input.evidence === "local-upstream-outage")
        return { error: "VERIFICATION_FAILED" };
      const accepted = input.evidence === fixture.evidence;
      if (accepted && !purchases.has(input.evidence))
        purchases.set(input.evidence, {
          owner: null,
          renews: true,
          expired: false,
          granted: false,
        });
      return {
        store: fixture.store,
        isValid: accepted && now() < fixture.expiresAt,
        state: !accepted
          ? "INAUTHENTIC"
          : now() >= fixture.expiresAt
            ? "EXPIRED"
            : "ENTITLED",
        ...(accepted ? { productId: fixture.productId } : {}),
        environment: "local-fixture",
      };
    },
    bindPurchase(input) {
      if (input.store !== fixture.store) return { error: "UNSUPPORTED_STORE" };
      if (typeof input.evidence !== "string")
        return { error: "INVALID_REQUEST" };
      const purchase = purchases.get(input.evidence);
      if (!purchase) return { bound: false };
      if (purchase.owner === null) {
        purchase.owner = input.userId;
        if (snapshot(purchase).active) {
          emit("entitlement.granted", purchase);
          purchase.granted = true;
        }
      }
      return { bound: purchase.owner === input.userId };
    },
    entitlements({ userId }) {
      const subscriptions = [...purchases.values()]
        .filter((purchase) => purchase.owner === userId)
        .map(snapshot)
        .filter((subscription) => subscription.active);
      return {
        userId,
        productIds: [...new Set(subscriptions.map((row) => row.productId))],
        subscriptions,
      };
    },
    subscriptionStatus({ userId }) {
      const purchase = [...purchases.values()].find(
        (row) => row.owner === userId,
      );
      const subscription = purchase ? snapshot(purchase) : undefined;
      return {
        active: subscription?.active ?? false,
        ...(subscription ? { subscription } : {}),
      };
    },
  };

  async function fetch(request) {
    const url = new URL(request.url);
    const spec = HTTP_BINDING.operations.find(
      (entry) => entry.path === url.pathname && entry.method === request.method,
    );
    if (!spec) return protocolError("NOT_FOUND");
    if (
      spec.auth !== "none" &&
      request.headers.get("authorization") !== credential
    )
      return protocolError("UNAUTHORIZED");
    if (!handlers[spec.name]) return protocolError("UNSUPPORTED_PROFILE");
    let input;
    try {
      input = spec.input
        ? request.method === "GET"
          ? Object.fromEntries(url.searchParams)
          : await request.json()
        : null;
    } catch {
      return protocolError("INVALID_REQUEST");
    }
    if (spec.input && !validate(spec.input, input))
      return protocolError("INVALID_REQUEST");
    const result = handlers[spec.name](input);
    if (result.error) return protocolError(result.error);
    if (!validate(operation(spec.name).result, result))
      return protocolError("INTERNAL_ERROR");
    return Response.json(result, { status: spec.successStatus });
  }

  function observe(kind) {
    const purchase = purchases.get(fixture.evidence);
    if (!purchase?.owner) throw new Error("Bind the fixture purchase first");
    if (kind === "cancel") {
      if (!purchase.renews) return;
      purchase.renews = false;
      emit("subscription.canceled", purchase);
    } else if (kind === "expire" && now() >= fixture.expiresAt) {
      if (purchase.expired) return;
      purchase.expired = true;
      purchase.renews = false;
      emit("subscription.expired", purchase);
      if (purchase.granted) {
        emit("entitlement.revoked", purchase);
        purchase.granted = false;
      }
    } else throw new Error("Invalid fixture transition");
  }

  function signed(event, secret) {
    const body = JSON.stringify(event);
    const timestamp = String(Math.floor(now() / 1000));
    const digest = createHmac("sha256", secret)
      .update(Buffer.concat([Buffer.from(`${timestamp}.`), Buffer.from(body)]))
      .digest("hex");
    return {
      body,
      headers: {
        "content-type": WEBHOOK.contentType,
        [WEBHOOK.timestampHeader]: timestamp,
        [WEBHOOK.signatureHeader]: WEBHOOK.signaturePrefix + digest,
        [WEBHOOK.eventIdHeader]: event.eventId,
      },
    };
  }

  async function flush(url, secret) {
    const results = [];
    for (const item of outbox.filter(
      (row) => row.status === "pending" && row.nextAt <= now(),
    )) {
      const request = signed(item.event, secret);
      let status;
      try {
        status = (
          await globalThis.fetch(url, {
            method: "POST",
            ...request,
            headers: {
              ...request.headers,
              [WEBHOOK.deliveryIdHeader]: item.deliveryId,
            },
            redirect: "error",
            signal: AbortSignal.timeout(5000),
          })
        ).status;
      } catch {
        status = 503;
      }
      item.attempts += 1;
      const retryable = status === 408 || status === 429 || status >= 500;
      item.status =
        status >= 200 && status < 300
          ? "delivered"
          : retryable && item.attempts < 3
            ? "pending"
            : "dead-letter";
      item.nextAt = now() + 30000 * 2 ** (item.attempts - 1);
      results.push({
        httpStatus: status,
        status: item.status,
        attempt: item.attempts,
      });
    }
    return results;
  }

  return {
    fetch,
    observe,
    flush,
    signed,
    events: () => outbox.map((row) => row.event),
  };
}
