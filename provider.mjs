import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import {
  providerCapabilitiesSchema,
  COMMERCE_EVENT_VERSION,
  HTTP_BINDING,
} from "openiap-commerce-protocol";
import { protocolError, validate } from "./contract.mjs";

export const FIXTURE = Object.freeze({
  store: "fixture",
  evidence: "local-purchase-alice",
  userId: "demo_alice",
  productId: "premium.monthly",
  startsAt: Date.UTC(2026, 8, 7, 9),
  expiresAt: Date.UTC(2026, 9, 7, 9),
});
export const CREDENTIALS = Object.freeze({
  verification: "Bearer local-demo-verification",
  server: "Bearer local-demo-server",
});
const fingerprint = (value) => createHash("sha256").update(value).digest("hex");

export function isEntitled(state, expiresAt, now) {
  return (
    (state === "Active" || state === "InGracePeriod") &&
    (expiresAt == null || now < expiresAt)
  );
}

// This adapter recognizes one fictional purchase; it never contacts a store.
function verifyFixture(input) {
  if (input.store !== FIXTURE.store) return { error: "UNSUPPORTED_STORE" };
  if (typeof input.evidence !== "string") return { error: "INVALID_REQUEST" };
  if (input.evidence === "local-upstream-outage") {
    return { error: "VERIFICATION_FAILED" };
  }
  return { accepted: input.evidence === FIXTURE.evidence };
}

export function createProvider(path, now) {
  const db = new Database(path, { create: true });
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS purchases (
      fingerprint TEXT PRIMARY KEY, user_id TEXT, product_id TEXT NOT NULL,
      state TEXT NOT NULL, expires_at INTEGER NOT NULL, will_renew INTEGER NOT NULL,
      observed_at INTEGER NOT NULL, entitlement_granted INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS observations (id TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS outbox (
      event_id TEXT PRIMARY KEY, delivery_id TEXT NOT NULL, body TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending',
      next_at INTEGER NOT NULL DEFAULT 0
    );
  `);

  function snapshot(row) {
    return {
      productId: row.product_id,
      state: row.state,
      active: isEntitled(row.state, row.expires_at, now()),
      store: FIXTURE.store,
      expiresAt: row.expires_at,
      willRenew: Boolean(row.will_renew),
    };
  }

  function rowsFor(userId) {
    return db.query("SELECT * FROM purchases WHERE user_id = ?").all(userId);
  }

  function entitlements(userId) {
    const subscriptions = rowsFor(userId)
      .map(snapshot)
      .filter((row) => row.active);
    return {
      userId,
      productIds: [...new Set(subscriptions.map((row) => row.productId))],
      subscriptions,
    };
  }

  const eventTypes = [
    "entitlement.granted",
    "subscription.canceled",
    "subscription.expired",
    "entitlement.revoked",
  ];
  const capabilityNames = Object.keys(
    providerCapabilitiesSchema.$defs.StoreCapabilities.properties,
  );
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
      name: "Commerce Protocol Example — fictional fixture store",
    },
    eventTypes,
    stores: {
      fixture: Object.fromEntries(
        capabilityNames.map((key) => [
          key,
          {
            provider: supported.has(key),
            implementation: supported.has(key),
            notes:
              "Local fixture demonstration only; no real store integration or profile conformance claim.",
          },
        ]),
      ),
    },
  };

  function enqueue(eventType, row, occurredAt, sourceStoreEventId) {
    const body = {
      eventId: randomUUID(),
      eventType,
      eventVersion: COMMERCE_EVENT_VERSION,
      occurredAt,
      processedAt: now(),
      store: FIXTURE.store,
      environment: "local-fixture",
      projectId: "commerce_example",
      productId: row.product_id,
      ...(row.user_id ? { userId: row.user_id } : {}),
      subscription: snapshot(row),
      ...(sourceStoreEventId ? { sourceStoreEventId } : {}),
    };
    if (!validate("#/$defs/CommerceEvent", body))
      throw new Error("Invalid event");
    db.query(
      "INSERT INTO outbox (event_id, delivery_id, body) VALUES (?, ?, ?)",
    ).run(body.eventId, randomUUID(), JSON.stringify(body));
  }

  const handlers = {
    providerCapabilities: () => capabilities,
    verifyPurchase(input) {
      const verdict = verifyFixture(input);
      if (verdict.error) return verdict;
      if (verdict.accepted) {
        db.query(
          `INSERT OR IGNORE INTO purchases (fingerprint, user_id, product_id, state, expires_at, will_renew, observed_at) VALUES (?, NULL, ?, 'Active', ?, 1, ?)`,
        ).run(
          fingerprint(input.evidence),
          FIXTURE.productId,
          FIXTURE.expiresAt,
          FIXTURE.startsAt,
        );
      }
      return {
        store: FIXTURE.store,
        isValid: verdict.accepted && now() < FIXTURE.expiresAt,
        state: !verdict.accepted
          ? "INAUTHENTIC"
          : now() >= FIXTURE.expiresAt
            ? "EXPIRED"
            : "ENTITLED",
        ...(verdict.accepted ? { productId: FIXTURE.productId } : {}),
        environment: "local-fixture",
      };
    },
    bindPurchase(input) {
      if (input.store !== FIXTURE.store) return { error: "UNSUPPORTED_STORE" };
      if (typeof input.evidence !== "string")
        return { error: "INVALID_REQUEST" };
      return db.transaction(() => {
        const key = fingerprint(input.evidence);
        const updated = db
          .query(
            "UPDATE purchases SET user_id = ? WHERE fingerprint = ? AND user_id IS NULL",
          )
          .run(input.userId, key);
        const row = db
          .query("SELECT * FROM purchases WHERE fingerprint = ?")
          .get(key);
        if (updated.changes && isEntitled(row.state, row.expires_at, now())) {
          enqueue("entitlement.granted", row, row.observed_at);
          db.query(
            "UPDATE purchases SET entitlement_granted = 1 WHERE fingerprint = ?",
          ).run(key);
        }
        return { bound: row?.user_id === input.userId };
      })();
    },
    entitlements: (input) => entitlements(input.userId),
    subscriptionStatus(input) {
      const snapshots = rowsFor(input.userId).map(snapshot);
      const subscription = snapshots.find((row) => row.active) ?? snapshots[0];
      return {
        active: snapshots.some((row) => row.active),
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
    const auth = request.headers.get("authorization");
    if (spec.auth !== "none") {
      if (!Object.values(CREDENTIALS).includes(auth))
        return protocolError("UNAUTHORIZED");
      if (spec.auth === "server" && auth !== CREDENTIALS.server)
        return protocolError("FORBIDDEN");
    }
    if (!handlers[spec.name]) return protocolError("UNSUPPORTED_PROFILE");
    let input = null;
    if (spec.input) {
      try {
        input =
          request.method === "GET"
            ? Object.fromEntries(url.searchParams)
            : await request.json();
      } catch {
        return protocolError("INVALID_REQUEST");
      }
      if (!validate(spec.input, input)) return protocolError("INVALID_REQUEST");
    }
    try {
      const result = handlers[spec.name](input);
      if (result.error) return protocolError(result.error);
      if (!validate(spec.result, result))
        throw new Error("Invalid protocol response");
      return Response.json(result, { status: spec.successStatus });
    } catch {
      return protocolError("INTERNAL_ERROR");
    }
  }

  function observe({ id, kind, occurredAt }) {
    if (
      !["cancel", "expire"].includes(kind) ||
      !Number.isSafeInteger(occurredAt) ||
      occurredAt > now()
    ) {
      throw new Error("Invalid fixture observation");
    }
    return db.transaction(() => {
      if (db.query("SELECT id FROM observations WHERE id = ?").get(id))
        return false;
      const row = db
        .query("SELECT * FROM purchases WHERE fingerprint = ?")
        .get(fingerprint(FIXTURE.evidence));
      if (!row) throw new Error("Verify the fixture purchase first");
      if (kind === "expire" && occurredAt < row.expires_at) {
        throw new Error("Premature expiry requires store reconciliation");
      }
      db.query("INSERT INTO observations VALUES (?)").run(id);
      if (occurredAt < row.observed_at) return false;
      if (
        (kind === "cancel" && (!row.will_renew || row.state !== "Active")) ||
        (kind === "expire" && row.state === "Expired")
      )
        return false;
      const next = {
        ...row,
        will_renew: 0,
        state: kind === "expire" ? "Expired" : row.state,
      };
      db.query(
        "UPDATE purchases SET state = ?, will_renew = 0, observed_at = ? WHERE fingerprint = ?",
      ).run(next.state, occurredAt, row.fingerprint);
      const types = [
        kind === "cancel" ? "subscription.canceled" : "subscription.expired",
      ];
      if (
        row.entitlement_granted &&
        !isEntitled(next.state, next.expires_at, now())
      ) {
        types.push("entitlement.revoked");
        db.query(
          "UPDATE purchases SET entitlement_granted = 0 WHERE fingerprint = ?",
        ).run(row.fingerprint);
      }
      for (const eventType of types) enqueue(eventType, next, occurredAt, id);
      return true;
    })();
  }

  function inspect() {
    return {
      purchases: db
        .query(
          "SELECT user_id AS userId, product_id AS productId, state, will_renew AS willRenew FROM purchases",
        )
        .all(),
      access: entitlements(FIXTURE.userId),
      deliveries: db
        .query(
          "SELECT event_id AS eventId, delivery_id AS deliveryId, attempts, status, body FROM outbox ORDER BY rowid",
        )
        .all()
        .map(({ body, ...row }) => ({
          ...row,
          eventType: JSON.parse(body).eventType,
        })),
    };
  }

  return { db, fetch, observe, inspect, close: () => db.close() };
}
