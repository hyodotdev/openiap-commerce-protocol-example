import { test, expect } from 'bun:test';
import { signatureVectors } from '@hyodotdev/openiap-commerce-protocol/conformance';
import { sign, verifySignature, classify, WEBHOOK_SECRET } from './delivery.mjs';
import { startServer } from './server.mjs';
import { request, receipt } from './test-client.mjs';

test('published signature and response vectors pass against the new transport', () => {
  for (const v of signatureVectors.cases) {
    const secrets = [v.secret, ...(v.previousSecret ? [v.previousSecret] : [])];
    expect(secrets.map(secret => sign(secret, v.timestamp, v.body)).join(',')).toBe(v.expected);
    for (const secret of secrets) expect(verifySignature({ body:v.body,timestamp:v.timestamp,signature:v.presentedHeader??v.expected,secrets:[secret],now:v.timestamp })).toBe(true);
  }
  for (const v of signatureVectors.rejections) expect(verifySignature({body:v.body,timestamp:v.timestamp,signature:v.presentedSignature,secrets:[v.secret],now:v.receiverNow??v.timestamp})).toBe(false);
  for (const v of signatureVectors.responseSemantics.cases) expect(classify(v.status)).toBe(v.action);
  expect(classify('timeout')).toBe('retry');
});

test('real HTTP retry and lost acknowledgement retain bytes and IDs, deduplicate, reject tampering, and dead-letter', async () => {
  let clock = Date.now();
  const app = startServer({ clock: () => clock });
  try {
    await request(app, '/commerce/v1/purchases/verify', receipt);
    await request(app, '/commerce/v1/purchases/bind', {...receipt,userId:'alice'});
    await request(app, '/fixture/cancel', {userId:'alice'});
    app.receiver.state.failNext = true;
    const first = await app.delivery.sendDue();
    expect(first.map(x=>x.status)).toEqual([503,202]);
    expect(app.receiver.db.query('SELECT count(*) n FROM inbox').get().n).toBe(1);
    expect(await app.delivery.sendDue()).toEqual([]);
    clock += 1001;
    app.receiver.state.loseAckNext = true;
    const second = await app.delivery.sendDue();
    expect(second[0].status).toBe(503);
    expect(second[0].headers['openiap-delivery-id']).toBe(first[0].headers['openiap-delivery-id']);
    expect(second[0].body).toEqual(first[0].body);
    expect(second[0].headers['openiap-signature']).not.toBe(first[0].headers['openiap-signature']);
    clock += 2001;
    const third = await app.delivery.sendDue();
    expect(third[0].status).toBe(202);
    expect(app.receiver.db.query('SELECT count(*) n FROM inbox').get().n).toBe(2);
    const tampered = await fetch(app.receiver.url,{method:'POST',headers:third[0].headers,body:JSON.stringify({...third[0].body,userId:'bob'})});
    expect(tampered.status).toBe(401);
    const row = app.backend.db.query('SELECT * FROM outbox LIMIT 1').get();
    app.backend.db.query("UPDATE outbox SET status='pending', attempts=0, next_attempt=0 WHERE id=?").run(row.id);
    for (let i=0;i<4;i++) { app.receiver.state.failNext=true; await app.delivery.sendDue(); clock += 9000; }
    expect(app.backend.db.query('SELECT status FROM outbox WHERE id=?').get(row.id).status).toBe('dead-letter');
    expect(app.receiver.db.query('SELECT count(*) n FROM inbox').get().n).toBe(2);
    const bytes=Buffer.from('{ invalid utf8: \uFFFD');
    const res=await fetch(app.receiver.url,{method:'POST',headers:{'Content-Type':'application/json','openiap-timestamp':String(Math.floor(clock/1000)),'openiap-signature':'v1=bad'},body:bytes});
    expect(res.status).toBe(401);
  } finally { await app.close(); }
});
