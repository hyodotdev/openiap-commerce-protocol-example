import { randomUUID } from 'node:crypto';
import { valid } from './contract.mjs';
import { ProtocolFault } from './contract.mjs';
import { Database } from 'bun:sqlite';

export const STAGE = 4;
export const START = Date.UTC(2026, 8, 13);
export const END = Date.UTC(2026, 9, 13);
export const PRODUCT = 'premium.monthly';
export function openBackend(path) {
  const db = new Database(path, { create: true });
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS purchases (
      evidence TEXT PRIMARY KEY, user_id TEXT, state TEXT NOT NULL,
      expires_at INTEGER NOT NULL, will_renew INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS observations (id TEXT PRIMARY KEY, evidence TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY, user_id TEXT, body TEXT NOT NULL, delivery_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, next_attempt INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
    INSERT OR IGNORE INTO settings VALUES ('clock', ${START});`);
  function now() { return db.query("SELECT value FROM settings WHERE key='clock'").get().value; }
  function snapshot(row) {
    return { productId: PRODUCT, state: row.state, active: ['Active', 'InGracePeriod'].includes(row.state) && now() < row.expires_at, store: 'fixture', expiresAt: row.expires_at, willRenew: Boolean(row.will_renew), ...(!row.will_renew ? { cancellationReason: 'UserCanceled' } : {}) };
  }
  function records(userId) {
    const rows = db.query('SELECT * FROM purchases WHERE user_id=? LIMIT 101').all(userId);
    if (rows.length > 100) throw new ProtocolFault('INTERNAL_ERROR');
    return rows.map(snapshot);
  }
  function emit(eventType, row, occurredAt) {
    const event = { eventId: randomUUID(), eventType, eventVersion: '1.0', occurredAt, processedAt: now(), store: 'fixture', environment: 'sandbox', projectId: 'fresh-example', ...(row.user_id ? { userId: row.user_id } : {}), productId: PRODUCT, subscription: snapshot(row) };
    if (!valid('#/$defs/CommerceEvent', event)) throw new ProtocolFault('INTERNAL_ERROR');
    db.query('INSERT INTO outbox (id,user_id,body,delivery_id) VALUES (?,?,?,?)').run(event.eventId, row.user_id, JSON.stringify(event), randomUUID());
    return event;
  }
  const api = {
    db,
    now,
    bind(input) {
      if (input.store !== 'fixture') return { bound: false };
      const receipt = input.fixture?.receipt;
      if (typeof receipt !== 'string' || !receipt || receipt.length > 256) throw new ProtocolFault('INVALID_REQUEST');
      return db.transaction(() => {
        const row = db.query('SELECT * FROM purchases WHERE evidence=?').get(receipt);
        if (!row || (row.user_id && row.user_id !== input.userId)) return { bound: false };
        db.query('UPDATE purchases SET user_id=? WHERE evidence=?').run(input.userId, receipt);
        if (!row.user_id && snapshot(row).active) emit('entitlement.granted', { ...row, user_id: input.userId }, START);
        return { bound: true };
      }).immediate();
    },
    cancel(userId) {
      return db.transaction(() => {
        const row = db.query('SELECT * FROM purchases WHERE user_id=? LIMIT 1').get(userId);
        if (!row) throw new ProtocolFault('NOT_FOUND');
        const observation = `cancel:${row.evidence}`;
        if (db.query('SELECT id FROM observations WHERE id=?').get(observation)) return { changed: false };
        db.query('UPDATE purchases SET will_renew=0 WHERE evidence=?').run(row.evidence);
        db.query('INSERT INTO observations VALUES (?,?)').run(observation, row.evidence);
        const event = emit('subscription.canceled', { ...row, will_renew: 0 }, now());
        return { changed: true, eventId: event.eventId };
      }).immediate();
    },
    entitlements({ userId }) {
      const subscriptions = records(userId).filter(row => row.active);
      return { userId, productIds: [...new Set(subscriptions.map(row => row.productId))], subscriptions };
    },
    status({ userId }) {
      const rows = records(userId);
      const subscription = rows.find(row => row.active) ?? rows.at(-1);
      return { active: rows.some(row => row.active), ...(subscription ? { subscription } : {}) };
    },
    verify(input) {
      if (input.store !== 'fixture') throw new ProtocolFault('UNSUPPORTED_STORE');
      const receipt = input.fixture?.receipt;
      if (typeof receipt !== 'string' || !receipt || receipt.length > 256) throw new ProtocolFault('INVALID_REQUEST');
      if (receipt === 'outage') throw new ProtocolFault('VERIFICATION_FAILED');
      const isValid = ['alice-monthly', 'bob-monthly'].includes(receipt);
      if (isValid) db.query("INSERT OR IGNORE INTO purchases VALUES (?, NULL, 'Active', ?, 1)").run(receipt, END);
      return { store: 'fixture', isValid, state: isValid ? 'ENTITLED' : 'INAUTHENTIC', ...(isValid ? { productId: PRODUCT } : {}), environment: 'sandbox' };
    },
    state(userId = 'alice') {
      return {
        stage: STAGE,
        now: db.query("SELECT value FROM settings WHERE key='clock'").get().value,
        purchases: db.query('SELECT count(*) AS count FROM purchases').get().count,
        queued: db.query("SELECT count(*) AS count FROM outbox WHERE status='pending'").get().count,
        access: api.status({ userId }).active,
        message: api.status({ userId }).active ? (api.status({ userId }).subscription.willRenew ? 'Premium is open. Cancel renewal to see why paid access continues.' : 'Renewal is canceled. Premium stays open until October 13; the change is queued for delivery.') : 'This customer has no current paid access. Verify the receipt, then connect it to Alice.',
      };
    },
    close() { db.close(); },
  };
  return api;
}
