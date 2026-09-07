import { Database } from "bun:sqlite";
import { createHmac, timingSafeEqual } from "node:crypto";
import { WEBHOOK } from "openiap-commerce-protocol";
import { validate } from "./contract.mjs";

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
  const db = new Database(path, { create: true });
  db.exec(
    "CREATE TABLE IF NOT EXISTS inbox (event_id TEXT PRIMARY KEY, body TEXT NOT NULL)",
  );

  async function fetch(request) {
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (
      !authentic(
        [secret],
        request.headers.get(WEBHOOK.timestampHeader),
        bytes,
        request.headers.get(WEBHOOK.signatureHeader),
        Math.floor(now() / 1000),
      )
    ) {
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
    // Inbox insertion is the durable effect; downstream jobs can consume it later.
    const result = db
      .query("INSERT OR IGNORE INTO inbox VALUES (?, ?)")
      .run(event.eventId, body);
    return Response.json({ accepted: true, duplicate: result.changes === 0 });
  }

  return {
    fetch,
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
  for (const row of rows) {
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
