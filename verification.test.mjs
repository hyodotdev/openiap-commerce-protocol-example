import { test, expect } from 'bun:test';
import { startServer } from './server.mjs';
import { request, receipt } from './test-client.mjs';

test('verification accepts evidence without creating ownership, rejects bad evidence, and distinguishes outage', async () => {
  const app = startServer();
  const path = '/commerce/v1/purchases/verify';
  try {
    expect((await request(app, path, receipt, null)).status).toBe(401);
    expect((await request(app, path, {}, 'verification')).status).toBe(400);
    expect((await request(app, path, { store: 'another_store' })).status).toBe(422);
    const yes = await request(app, path, { ...receipt, userId: 'injected' }, 'verification');
    expect(yes.status).toBe(200);
    expect(yes.body.isValid).toBe(true);
    expect(app.backend.db.query('SELECT user_id FROM purchases').get().user_id).toBe(null);
    expect((await request(app, path, receipt)).body).toEqual(yes.body);
    expect(app.backend.state().purchases).toBe(1);
    const no = await request(app, path, { store: 'fixture', fixture: { receipt: 'not-a-receipt' } });
    expect(no.status).toBe(200);
    expect(no.body.isValid).toBe(false);
    const outage = await request(app, path, { store: 'fixture', fixture: { receipt: 'outage' } });
    expect(outage.status).toBe(502);
    expect(outage.body.error.code).toBe('VERIFICATION_FAILED');
    expect(app.backend.state().purchases).toBe(1);
  } finally { await app.close(); }
});
