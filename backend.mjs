import { randomUUID, createHmac } from 'node:crypto';
import { valid } from './contract.mjs';
import { ProtocolFault } from './contract.mjs';
import { Database } from 'bun:sqlite';

export const STAGE = 7;
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
    CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS erased_users (marker TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS retired_purchases (evidence TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS notified_gates (evidence TEXT PRIMARY KEY, active INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS observations (id TEXT PRIMARY KEY, evidence TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY, user_id TEXT, body TEXT NOT NULL, delivery_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, next_attempt INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
    INSERT OR IGNORE INTO settings VALUES ('clock', ${START});`);
  if (!db.query('PRAGMA table_info(purchases)').all().some(col => col.name === 'store')) db.exec("ALTER TABLE purchases ADD COLUMN store TEXT NOT NULL DEFAULT 'fixture'");
  db.query('INSERT OR IGNORE INTO metadata VALUES (?,?)').run('erasure-key', randomUUID());
  const erasureKey = db.query("SELECT value FROM metadata WHERE key='erasure-key'").get().value;
  const marker = userId => createHmac('sha256', erasureKey).update(userId).digest('hex');
  const erased = userId => Boolean(db.query('SELECT marker FROM erased_users WHERE marker=?').get(marker(userId)));
  function now() { return db.query("SELECT value FROM settings WHERE key='clock'").get().value; }
  function snapshot(row) {
    return { productId: PRODUCT, state: row.state, active: ['Active', 'InGracePeriod'].includes(row.state) && now() < row.expires_at, store: row.store, expiresAt: row.expires_at, willRenew: Boolean(row.will_renew), ...(!row.will_renew ? { cancellationReason: 'UserCanceled' } : {}) };
  }
  function records(userId) {
    if (erased(userId)) return [];
    const rows = db.query('SELECT * FROM purchases WHERE user_id=? LIMIT 101').all(userId);
    if (rows.length > 100) throw new ProtocolFault('INTERNAL_ERROR');
    return rows.map(snapshot);
  }
  function emit(eventType, row, occurredAt) {
    const event = { eventId: randomUUID(), eventType, eventVersion: '1.0', occurredAt, processedAt: now(), store: row.store, environment: 'sandbox', projectId: 'fresh-example', ...(row.user_id ? { userId: row.user_id } : {}), productId: PRODUCT, subscription: snapshot(row) };
    if (!valid('#/$defs/CommerceEvent', event)) throw new ProtocolFault('INTERNAL_ERROR');
    db.query('INSERT INTO outbox (id,user_id,body,delivery_id) VALUES (?,?,?,?)').run(event.eventId, row.user_id, JSON.stringify(event), randomUUID());
    if (row.user_id) db.query('INSERT OR REPLACE INTO notified_gates VALUES (?,?)').run(row.evidence, Number(event.subscription.active));
    return event;
  }
  function evidence(input) {
    if (!['fixture', 'google'].includes(input.store)) throw new ProtocolFault('UNSUPPORTED_STORE');
    const token = input.store === 'google' ? input.google?.purchaseToken : input.fixture?.receipt;
    if (typeof token !== 'string' || !token || token.length > (input.store === 'google' ? 4096 : 256)) throw new ProtocolFault('INVALID_REQUEST');
    return { token, key: input.store === 'google' ? `google:${token}` : token };
  }
  const api = {
    db,
    now,
    erased,
    erase(userId) {
      return db.transaction(() => {
        db.query('INSERT OR IGNORE INTO erased_users VALUES (?)').run(marker(userId));
        for (const row of db.query('SELECT evidence FROM purchases WHERE user_id=?').all(userId)) {
          db.query('INSERT OR IGNORE INTO retired_purchases VALUES (?)').run(row.evidence);
          db.query('DELETE FROM observations WHERE evidence=?').run(row.evidence);
          db.query('DELETE FROM notified_gates WHERE evidence=?').run(row.evidence);
        }
        db.query('DELETE FROM outbox WHERE user_id=?').run(userId);
        db.query('UPDATE purchases SET user_id=NULL WHERE user_id=?').run(userId);
        return { accepted: true, status: 'completed' };
      }).immediate();
    },
    capabilities() {
      const supported = new Set(['initialValidation', 'serverNotifications', 'subscriptions', 'entitlements', 'expiration']);
      const axes = ['initialValidation','serverNotifications','subscriptions','renewalEvents','refundEvents','expiration','reconciliation','entitlements','revenueAmount'];
      const fixture = Object.fromEntries(axes.map(key => [key, { provider: supported.has(key), implementation: supported.has(key), notes: supported.has(key) ? 'Fictional fixture only; no real store connected.' : 'Not implemented by this local fixture.' }]));
      return { specVersion: '1.0', profiles: { verification: '1.0', entitlements: '1.0', accountLifecycle: '1.0' }, bindings: { rest: '1.0' }, implementation: { name: 'Fresh local fixture (not a live Google provider)', version: '0.0.0' }, eventTypes: ['entitlement.granted', 'subscription.canceled', 'subscription.expired', 'entitlement.revoked'], stores: { fixture, google: Object.fromEntries(axes.map(key => [key, { provider: supported.has(key), implementation: supported.has(key), notes: 'Google wire-format fixture and simulated lifecycle controls only. No Google API calls, RTDN, credentials, or real purchase validation.' }])) } };
    },
    bind(input) {
      if (!['fixture','google'].includes(input.store)) return { bound: false };
      const { key: receipt } = evidence(input);
      return db.transaction(() => {
        const row = db.query('SELECT * FROM purchases WHERE evidence=?').get(receipt);
        if (erased(input.userId) || db.query('SELECT evidence FROM retired_purchases WHERE evidence=?').get(receipt)) return { bound: false };
        if (!row || (row.user_id && row.user_id !== input.userId)) return { bound: false };
        db.query('UPDATE purchases SET user_id=? WHERE evidence=?').run(input.userId, receipt);
        if (!row.user_id && snapshot(row).active) emit('entitlement.granted', { ...row, user_id: input.userId }, START);
        return { bound: true };
      }).immediate();
    },
    setClock(value) {
      if (!Number.isSafeInteger(value) || value < now()) throw new ProtocolFault('INVALID_REQUEST');
      db.query("UPDATE settings SET value=? WHERE key='clock'").run(value);
      return { now: now() };
    },
    expire(userId) {
      return db.transaction(() => {
        const row = db.query('SELECT * FROM purchases WHERE user_id=? LIMIT 1').get(userId);
        if (!row) throw new ProtocolFault('NOT_FOUND');
        if (now() < row.expires_at) throw new ProtocolFault('CONFLICT');
        const observation = `expire:${row.evidence}`;
        if (db.query('SELECT id FROM observations WHERE id=?').get(observation)) return { changed: false };
        const previousGate = db.query('SELECT active FROM notified_gates WHERE evidence=?').get(row.evidence)?.active;
        db.query("UPDATE purchases SET state='Expired',will_renew=0 WHERE evidence=?").run(row.evidence);
        db.query('INSERT INTO observations VALUES (?,?)').run(observation, row.evidence);
        const expired = { ...row, state: 'Expired', will_renew: 0 };
        emit('subscription.expired', expired, row.expires_at);
        if (previousGate && row.user_id) emit('entitlement.revoked', expired, row.expires_at);
        return { changed: true };
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
        const previousGate = db.query('SELECT active FROM notified_gates WHERE evidence=?').get(row.evidence)?.active;
        const event = emit('subscription.canceled', { ...row, will_renew: 0 }, now());
        if (previousGate && !event.subscription.active && row.user_id) emit('entitlement.revoked', { ...row, will_renew: 0 }, now());
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
      const { token, key } = evidence(input);
      if (['outage', 'fixture-google-outage'].includes(token)) throw new ProtocolFault('VERIFICATION_FAILED');
      const isValid = (input.store === 'google' ? ['fixture-google-alice','fixture-google-bob'] : ['alice-monthly','bob-monthly']).includes(token);
      if (isValid) db.query("INSERT OR IGNORE INTO purchases (evidence,user_id,state,expires_at,will_renew,store) VALUES (?,NULL,'Active',?,1,?)").run(key, END, input.store);
      return { store: input.store, isValid, state: isValid ? 'ENTITLED' : 'INAUTHENTIC', ...(isValid ? { productId: PRODUCT } : {}), environment: 'sandbox' };
    },
    state(userId = 'alice') {
      return {
        stage: STAGE,
        erased: erased(userId),
        now: db.query("SELECT value FROM settings WHERE key='clock'").get().value,
        purchases: db.query('SELECT count(*) AS count FROM purchases').get().count,
        queued: db.query("SELECT count(*) AS count FROM outbox WHERE status='pending'").get().count,
        access: api.status({ userId }).active,
        message: erased(userId) ? 'This test account has been erased. Its old session and purchase can no longer create access.' : api.status({ userId }).active ? (api.status({ userId }).subscription.willRenew ? 'Premium is open. Cancel renewal to see why paid access continues.' : 'Renewal is canceled. Premium stays open until October 13; the change is queued for delivery.') : (api.status({ userId }).subscription ? 'The paid period has ended. Premium is locked, including after a server restart.' : 'This customer has no current paid access. Verify the receipt, then connect it to Alice.'),
      };
    },
    close() { db.close(); },
  };
  return api;
}
