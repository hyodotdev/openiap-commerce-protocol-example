import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import { Database } from 'bun:sqlite';
import { valid, knownEvents } from './contract.mjs';

export const WEBHOOK_SECRET = 'fixture-shared-between-local-servers';
export function sign(secret, timestamp, body) {
  return 'v1=' + createHmac('sha256', secret).update(String(timestamp) + '.').update(body).digest('hex');
}
export function verifySignature({ body, timestamp, signature, secrets, now }) {
  if (!/^(0|[1-9][0-9]*)$/.test(String(timestamp)) || !Number.isSafeInteger(Number(timestamp)) || Math.abs(now - Number(timestamp)) > 300) return false;
  if (typeof signature !== 'string') return false;
  const candidates = signature.split(',').map(value => value.trim()).filter(value => /^v1=[a-f0-9]{64}$/.test(value));
  return secrets.some(secret => candidates.some(candidate => timingSafeEqual(Buffer.from(candidate), Buffer.from(sign(secret, timestamp, body)))));
}
export function classify(status) {
  if (typeof status !== 'number' || status === 408 || status === 429 || status >= 500) return 'retry';
  return status >= 200 && status < 300 ? 'delivered' : 'permanent-failure';
}
export function startReceiver({ path = ':memory:', clock = Date.now, port = 0 } = {}) {
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS inbox (project_id TEXT NOT NULL, event_id TEXT NOT NULL, user_id TEXT, body TEXT NOT NULL, PRIMARY KEY(project_id,event_id));");
  db.exec('CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS erased_users (marker TEXT PRIMARY KEY);');
  db.query('INSERT OR IGNORE INTO metadata VALUES (?,?)').run('erasure-key', randomUUID());
  const key = db.query("SELECT value FROM metadata WHERE key='erasure-key'").get().value;
  const marker = userId => createHmac('sha256', key).update(userId).digest('hex');
  function erase(userId) {
    return db.transaction(() => {
      db.query('INSERT OR IGNORE INTO erased_users VALUES (?)').run(marker(userId));
      db.query('DELETE FROM inbox WHERE user_id=?').run(userId);
      return { accepted: true };
    }).immediate();
  }
  const state = { failNext: false, loseAckNext: false };
  const server = Bun.serve({ hostname: '127.0.0.1', port, maxRequestBodySize: 65536, async fetch(request) {
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/webhooks/commerce') return new Response(null, { status: 404 });
    if (!request.headers.get('content-type')?.startsWith('application/json') || !['identity', null].includes(request.headers.get('content-encoding'))) return new Response(null, { status: 400 });
    const body = Buffer.from(await request.arrayBuffer());
    if (!verifySignature({ body, timestamp: request.headers.get('openiap-timestamp'), signature: request.headers.get('openiap-signature'), secrets: [WEBHOOK_SECRET], now: Math.floor(clock() / 1000) })) return new Response(null, { status: 401 });
    let event;
    try { event = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)); } catch { return new Response(null, { status: 400 }); }
    if (typeof event?.eventVersion !== 'string') return new Response(null, { status: 400 });
    if (event.eventVersion.split('.')[0] !== '1') return new Response(null, { status: 200 });
    if (!valid('#/$defs/CommerceEvent', event)) return new Response(null, { status: 400 });
    if (event.projectId !== 'fresh-example') return new Response(null, { status: 403 });
    if (!knownEvents.includes(event.eventType)) return new Response(null, { status: 200 });
    if (state.failNext) { state.failNext = false; return new Response(null, { status: 503 }); }
    try {
      db.transaction(() => {
        if (event.userId && db.query('SELECT marker FROM erased_users WHERE marker=?').get(marker(event.userId))) return;
        db.query('INSERT OR IGNORE INTO inbox VALUES (?,?,?,?)').run(event.projectId, event.eventId, event.userId ?? null, body.toString('utf8'));
      }).immediate();
    } catch { return new Response(null, { status: 503 }); }
    if (state.loseAckNext) { state.loseAckNext = false; return new Response(null, { status: 503 }); }
    return new Response(null, { status: 202 });
  }});
  return { db, state, erase, url: server.url.origin + '/webhooks/commerce', async close() { await server.stop(true); db.close(); } };
}
export function createDelivery(backend, destination, { clock = Date.now } = {}) {
  const url = new URL(destination);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/webhooks/commerce') throw new Error('This local fixture only delivers to its loopback receiver');
  let running;
  async function sendDue() {
    const rows = backend.db.query("SELECT * FROM outbox WHERE status='pending' AND next_attempt<=? ORDER BY rowid").all(clock());
    const trace = [];
    for (const row of rows) {
      if (!backend.db.query('SELECT id FROM outbox WHERE id=?').get(row.id)) continue;
      const timestamp = Math.floor(clock() / 1000);
      const headers = { 'Content-Type': 'application/json', 'openiap-timestamp': String(timestamp), 'openiap-signature': sign(WEBHOOK_SECRET, timestamp, row.body), 'openiap-event-id': row.id, 'openiap-delivery-id': row.delivery_id };
      let status;
      try { const response = await fetch(destination, { method: 'POST', headers, body: row.body, redirect: 'manual', signal: AbortSignal.timeout(2000) }); status = response.status; await response.arrayBuffer(); } catch { status = 'connection-error'; }
      const attempts = row.attempts + 1;
      const classification = classify(status);
      const outcome = classification === 'retry' ? (attempts >= 4 ? 'dead-letter' : 'pending') : classification;
      backend.db.query('UPDATE outbox SET attempts=?,status=?,next_attempt=? WHERE id=?').run(attempts, outcome, clock() + 1000 * 2 ** (attempts - 1), row.id);
      trace.push({ method: 'POST', destination, headers, body: JSON.parse(row.body), status, outcome, attempt: attempts });
    }
    return trace;
  }
  return {
    sendDue() {
      if (!running) running = sendDue().finally(() => { running = undefined; });
      return running;
    },
    async drain() {
      const trace = [];
      for (let i = 0; i < 4; i++) {
        trace.push(...await this.sendDue());
        const next = backend.db.query("SELECT min(next_attempt) at FROM outbox WHERE status='pending'").get().at;
        if (next === null) break;
        await new Promise(resolve => setTimeout(resolve, Math.max(0, next - clock())));
      }
      return trace;
    },
  };
}
