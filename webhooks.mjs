import { Database } from "bun:sqlite";
import { createHmac, timingSafeEqual } from "node:crypto";
import { WEBHOOK } from "openiap-commerce-protocol";
import { validate } from "./contract.mjs";
import { createErasureLedger } from "./erasure.mjs";

export function sign(secret, timestamp, body) {
  return (
    WEBHOOK.signaturePrefix +
    createHmac("sha256", secret)
      .update(`${timestamp}.`)
      .update(body)
      .digest("hex")
  );
}

export function authentic(secrets, timestamp, body, signatures, nowSeconds) {
  if (!/^\d+$/.test(timestamp ?? "")) return false;
  if (
    !Number.isSafeInteger(Number(timestamp)) ||
    Math.abs(nowSeconds - Number(timestamp)) > WEBHOOK.toleranceSeconds
  )
    return false;
  return (signatures ?? "").split(",").some((raw) => {
    const candidate = raw.trim();
    if (!/^v1=[a-f0-9]{64}$/.test(candidate)) return false;
    return secrets.some((secret) =>
      timingSafeEqual(
        Buffer.from(candidate),
        Buffer.from(sign(secret, timestamp, body)),
      ),
    );
  });
}

export function createReceiver(path, secret, now) {
  const emitters =
    typeof secret === "string" ? [{ name: "default", secret }] : secret;
  if (
    !Array.isArray(emitters) ||
    !emitters.length ||
    emitters.some(
      (entry) =>
        !entry.name ||
        !entry.secret ||
        (typeof secret !== "string" && !entry.projectId),
    )
  )
    throw new Error(
      "Configure each emitter with a name, project ID, and signing secret",
    );
  if (new Set(emitters.map((entry) => entry.name)).size !== emitters.length)
    throw new Error("Emitter names must be unique");
  const db = new Database(path, { create: true });
  db.exec(
    "CREATE TABLE IF NOT EXISTS inbox (event_id TEXT PRIMARY KEY, body TEXT NOT NULL)",
  );
  const erasures = createErasureLedger(db);
  // Upgrade old single-emitter event IDs without losing durable deduplication.
  db.transaction(() => {
    for (const row of db.query("SELECT event_id, body FROM inbox").all()) {
      const event = JSON.parse(row.body);
      if (row.event_id !== event.eventId) continue;
      const matching = emitters.filter(
        (entry) => entry.projectId === event.projectId,
      );
      const name = matching.length === 1 ? matching[0].name : "default";
      const identity = JSON.stringify([name, event.projectId, event.eventId]);
      db.query("INSERT OR IGNORE INTO inbox VALUES (?, ?)").run(
        identity,
        row.body,
      );
      db.query("DELETE FROM inbox WHERE event_id = ?").run(row.event_id);
    }
  })();

  async function fetch(request) {
    const bytes = new Uint8Array(await request.arrayBuffer());
    const authenticated = emitters.filter((emitter) =>
      authentic(
        [emitter.secret],
        request.headers.get(WEBHOOK.timestampHeader),
        bytes,
        request.headers.get(WEBHOOK.signatureHeader),
        Math.floor(now() / 1000),
      ),
    );
    if (!authenticated.length) {
      return new Response("Invalid signature", { status: 401 });
    }
    let body, event;
    try {
      body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      event = JSON.parse(body);
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }
    if (!validate("#/$defs/CommerceEvent", event))
      return new Response("Invalid event", { status: 400 });
    if (request.headers.get(WEBHOOK.eventIdHeader) !== event.eventId)
      return new Response("Event ID mismatch", { status: 400 });
    const emitter = authenticated.find(
      (entry) => !entry.projectId || entry.projectId === event.projectId,
    );
    if (!emitter)
      return new Response("Unexpected emitter project", { status: 401 });
    if (event.userId && erasures.has(event.userId))
      return Response.json({ accepted: true, discarded: "erased-user" });
    // Inbox insertion is the durable effect; downstream jobs can consume it later.
    const result = db
      .query("INSERT OR IGNORE INTO inbox VALUES (?, ?)")
      .run(
        JSON.stringify([emitter.name, event.projectId, event.eventId]),
        body,
      );
    return Response.json({ accepted: true, duplicate: result.changes === 0 });
  }

  return {
    fetch,
    eraseUser(userId) {
      return db.transaction(() => {
        erasures.remember(userId);
        return db
          .query("DELETE FROM inbox WHERE json_extract(body, '$.userId') = ?")
          .run(userId).changes;
      })();
    },
    inspect: () =>
      db
        .query("SELECT body FROM inbox ORDER BY rowid")
        .all()
        .map((row) => JSON.parse(row.body)),
    count: () => db.query("SELECT count(*) AS count FROM inbox").get().count,
    close: () => db.close(),
  };
}

// The caller injects a loopback test transport. This is not a public HTTPS worker.
export async function deliver(provider, secret, now, post) {
  const results = [];
  const rows = provider.db
    .query(
      "SELECT * FROM outbox WHERE status = 'pending' AND next_at <= ? ORDER BY rowid",
    )
    .all(now());
  for (const candidate of rows) {
    const row = provider.db
      .query("SELECT * FROM outbox WHERE event_id = ? AND status = 'pending'")
      .get(candidate.event_id);
    if (!row) continue;
    const timestamp = Math.floor(now() / 1000).toString();
    const headers = {
      "content-type": WEBHOOK.contentType,
      [WEBHOOK.timestampHeader]: timestamp,
      [WEBHOOK.signatureHeader]: sign(secret, timestamp, row.body),
      [WEBHOOK.eventIdHeader]: row.event_id,
      [WEBHOOK.deliveryIdHeader]: row.delivery_id,
    };
    let status;
    try {
      status = (await post({ method: "POST", headers, body: row.body })).status;
    } catch {
      status = 503;
    }
    const attempts = row.attempts + 1;
    const retryable = status === 408 || status === 429 || status >= 500;
    const next =
      status >= 200 && status < 300
        ? "delivered"
        : retryable && attempts < 3
          ? "pending"
          : "dead-letter";
    provider.db
      .query(
        "UPDATE outbox SET attempts = ?, status = ?, next_at = ? WHERE event_id = ?",
      )
      .run(attempts, next, now() + 30_000 * 2 ** (attempts - 1), row.event_id);
    results.push({
      eventId: row.event_id,
      deliveryId: row.delivery_id,
      httpStatus: status,
      attempt: attempts,
      status: next,
    });
  }
  return results;
}
