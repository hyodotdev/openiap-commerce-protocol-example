import { mkdirSync } from 'node:fs';
import { openBackend } from './backend.mjs';
import { manifest, valid, failure, result, ProtocolFault } from './contract.mjs';

export const CREDENTIALS = { verification: 'fixture-verification', server: 'fixture-server' };
export function startServer({ path = ':memory:', port = 0 } = {}) {
  const backend = openBackend(path);
  const server = Bun.serve({ hostname: '127.0.0.1', port, maxRequestBodySize: 32768, async fetch(request) {
    try {
      const url = new URL(request.url);
      if (url.pathname === '/' && request.method === 'GET') return new Response(Bun.file(new URL('./dashboard.html', import.meta.url)), { headers: { 'Content-Type': 'text/html' } });
      if (url.pathname === '/demo/state' && request.method === 'GET') return Response.json(backend.state(url.searchParams.get('user') === 'bob' ? 'bob' : 'alice'));
      if (['/demo/verify', '/demo/bind', '/demo/cancel'].includes(url.pathname) && request.method === 'POST') {
        if (request.headers.get('origin') && request.headers.get('origin') !== url.origin) return failure('FORBIDDEN');
        let body;
        try { body = await request.json(); } catch { return failure('INVALID_REQUEST'); }
        const userId = body.user === 'bob' ? 'bob' : 'alice';
        const trace = [];
        async function call(path, input, method = 'POST') {
          const response = await fetch(server.url.origin + path, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${CREDENTIALS.server}` }, ...(method === 'POST' ? { body: JSON.stringify(input) } : {}) });
          const data = await response.json();
          trace.push({ method, path, ...(method === 'POST' ? { input } : {}), status: response.status, response: data });
          return data;
        }
        const input = { store: 'fixture', fixture: { receipt: 'alice-monthly' } };
        if (url.pathname === '/demo/verify') await call('/commerce/v1/purchases/verify', input);
        else if (url.pathname === '/demo/bind') {
          await call('/commerce/v1/purchases/bind', { ...input, userId });
          await call('/commerce/v1/entitlements?userId=' + userId, undefined, 'GET');
        }
        if (url.pathname === '/demo/cancel') {
          await call('/fixture/cancel', { userId });
          await call('/commerce/v1/subscriptions/status?userId=' + userId, undefined, 'GET');
        }
        return Response.json({ trace });
      }
      if (url.pathname === '/fixture/cancel' && request.method === 'POST') {
        if (request.headers.get('authorization') !== `Bearer ${CREDENTIALS.server}`) return failure('UNAUTHORIZED');
        let input;
        try { input = await request.json(); } catch { return failure('INVALID_REQUEST'); }
        if (!valid('#/$defs/SubscriptionStatusInput', input)) return failure('INVALID_REQUEST');
        return Response.json(backend.cancel(input.userId));
      }
      const operation = manifest.operations.find(op => op.path === url.pathname && op.method === request.method);
      if (!operation) return failure('NOT_FOUND');
      if (operation.name === 'providerCapabilities') return failure('INTERNAL_ERROR');
      const credential = request.headers.get('authorization');
      const role = Object.keys(CREDENTIALS).find(key => credential === `Bearer ${CREDENTIALS[key]}`);
      if (!role) return failure('UNAUTHORIZED');
      if (operation.auth === 'server' && role !== 'server') return failure('FORBIDDEN');
      let input;
      if (operation.method === 'POST') {
        if (!request.headers.get('content-type')?.startsWith('application/json')) return failure('INVALID_REQUEST');
        try { input = await request.json(); } catch { return failure('INVALID_REQUEST'); }
      } else input = Object.fromEntries(url.searchParams);
      if (operation.input && !valid(operation.input, input)) return failure('INVALID_REQUEST');
      if (operation.name === 'verifyPurchase') return result(operation, backend.verify(input));
      if (operation.name === 'bindPurchase') return result(operation, backend.bind(input));
      if (operation.name === 'entitlements') return result(operation, backend.entitlements(input));
      if (operation.name === 'subscriptionStatus') return result(operation, backend.status(input));
      return failure('UNSUPPORTED_PROFILE');
    } catch (error) { return failure(error instanceof ProtocolFault ? error.code : 'INTERNAL_ERROR'); }
  }});
  return { server, backend, url: server.url.origin, async close() { await server.stop(true); backend.close(); } };
}
if (import.meta.main) {
  mkdirSync('.runtime', { recursive: true });
  const app = startServer({ path: '.runtime/provider.sqlite', port: Number(process.env.PORT ?? 5196) });
  console.log(`Commerce Protocol from scratch: ${app.url}`);
  process.on('SIGINT', async () => { await app.close(); process.exit(0); });
  process.on('SIGTERM', async () => { await app.close(); process.exit(0); });
}
