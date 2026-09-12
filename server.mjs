import { mkdirSync } from 'node:fs';
import { openBackend } from './backend.mjs';
import { manifest, failure, result } from './contract.mjs';

export const CREDENTIALS = { verification: 'fixture-verification', server: 'fixture-server' };
export function startServer({ path = ':memory:', port = 0 } = {}) {
  const backend = openBackend(path);
  const server = Bun.serve({ hostname: '127.0.0.1', port, async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/' && request.method === 'GET') return new Response(Bun.file(new URL('./dashboard.html', import.meta.url)), { headers: { 'Content-Type': 'text/html' } });
    if (url.pathname === '/demo/state' && request.method === 'GET') return Response.json(backend.state());
    const operation = manifest.operations.find(op => op.path === url.pathname && op.method === request.method);
    if (!operation) return failure('NOT_FOUND');
    if (operation.name === 'providerCapabilities') return failure('INTERNAL_ERROR');
    return failure('UNSUPPORTED_PROFILE');
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
