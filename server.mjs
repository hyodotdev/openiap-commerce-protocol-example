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
      if (url.pathname === '/demo/state' && request.method === 'GET') return Response.json(backend.state());
      if (url.pathname === '/demo/verify' && request.method === 'POST') {
        if (request.headers.get('origin') && request.headers.get('origin') !== url.origin) return failure('FORBIDDEN');
        const input = { store: 'fixture', fixture: { receipt: 'alice-monthly' } };
        const path = '/commerce/v1/purchases/verify';
        const response = await fetch(server.url.origin + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${CREDENTIALS.server}` }, body: JSON.stringify(input) });
        return Response.json({ trace: [{ method: 'POST', path, input, status: response.status, response: await response.json() }] }, { status: response.status });
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
