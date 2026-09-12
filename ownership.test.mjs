import { test, expect } from 'bun:test';
import { startServer } from './server.mjs';
import { request, receipt } from './test-client.mjs';

test('only server role can bind; concurrent claims select one owner and reads contain no evidence', async () => {
  const app = startServer();
  const bind = '/commerce/v1/purchases/bind';
  try {
    expect((await request(app, bind, {}, null)).status).toBe(401);
    expect((await request(app, bind, { userId: 42 }, 'verification')).status).toBe(403);
    expect((await request(app, bind, { ...receipt, userId: 'alice' })).body.bound).toBe(false);
    await request(app, '/commerce/v1/purchases/verify', receipt);
    const claims = await Promise.all(['alice', 'bob'].map(userId => request(app, bind, { ...receipt, userId })));
    expect(claims.filter(x => x.body.bound)).toHaveLength(1);
    const owner = claims[0].body.bound ? 'alice' : 'bob';
    const other = owner === 'alice' ? 'bob' : 'alice';
    expect((await request(app, bind, { ...receipt, userId: owner })).body.bound).toBe(true);
    expect((await request(app, bind, { ...receipt, userId: other })).body.bound).toBe(false);
    const access = await request(app, '/commerce/v1/entitlements?userId=' + owner, undefined, 'server', 'GET');
    expect(access.body.productIds).toEqual(['premium.monthly']);
    expect(JSON.stringify(access.body)).not.toContain('receipt');
    expect(JSON.stringify(access.body)).not.toContain('alice-monthly');
    expect(app.backend.state(other).access).toBe(false);
    expect((await request(app, '/commerce/v1/entitlements?userId=' + owner, undefined, 'verification', 'GET')).status).toBe(403);
    expect((await request(app, '/commerce/v1/subscriptions/status?userId=' + owner, undefined, 'server', 'GET')).body.active).toBe(true);
    const injected = await request(app, '/demo/bind', { user: other, userId: owner });
    expect(injected.body.trace[0].input.userId).toBe(other);
    expect(injected.body.trace[0].response.bound).toBe(false);
  } finally { await app.close(); }
});
