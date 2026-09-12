import { test, expect } from 'bun:test';
import { startServer } from './server.mjs';
import { request, receipt } from './test-client.mjs';
import { valid } from './contract.mjs';

test('cancellation keeps paid access and atomically saves one observation and immutable event', async () => {
  const app = startServer();
  try {
    await request(app, '/commerce/v1/purchases/verify', receipt);
    await request(app, '/commerce/v1/purchases/bind', { ...receipt, userId: 'alice' });
    const db = app.backend.db;
    expect(db.query('SELECT count(*) n FROM outbox').get().n).toBe(1);
    db.exec("CREATE TRIGGER reject_event BEFORE INSERT ON outbox BEGIN SELECT RAISE(ABORT, 'test disk failure'); END;");
    const fail = await request(app, '/fixture/cancel', { userId: 'alice' });
    expect(fail.status).toBe(500);
    expect(app.backend.status({ userId: 'alice' }).subscription.willRenew).toBe(true);
    expect(db.query('SELECT count(*) n FROM observations').get().n).toBe(0);
    expect(db.query('SELECT count(*) n FROM outbox').get().n).toBe(1);
    db.exec('DROP TRIGGER reject_event');
    expect((await request(app, '/fixture/cancel', { userId: 'alice' })).body.changed).toBe(true);
    const bytes = db.query('SELECT body FROM outbox ORDER BY rowid').all();
    expect(bytes).toHaveLength(2);
    expect(bytes.every(row => valid('#/$defs/CommerceEvent', JSON.parse(row.body)))).toBe(true);
    const status = app.backend.status({ userId: 'alice' });
    expect(status.active).toBe(true);
    expect(status.subscription.willRenew).toBe(false);
    expect((await request(app, '/fixture/cancel', { userId: 'alice' })).body.changed).toBe(false);
    expect(db.query('SELECT body FROM outbox ORDER BY rowid').all()).toEqual(bytes);
  } finally { await app.close(); }
});
