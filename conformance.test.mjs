import { test, expect } from 'bun:test';
import Ajv from 'ajv/dist/2020.js';
import { createRestAdapter, runConformance } from '@hyodotdev/openiap-commerce-protocol/conformance';
import { startServer, CREDENTIALS } from './server.mjs';

test('published portable runner verifies the declared REST operation profiles', async () => {
  const app=startServer();
  try {
    const report=await runConformance({adapters:[createRestAdapter({baseUrl:app.url,fetch,credentials:CREDENTIALS})],Ajv,credentials:CREDENTIALS});
    console.log(JSON.stringify({suite:'portable-conformance',...report},null,2));
    expect(report.ok).toBe(true);
  } finally {await app.close();}
});
