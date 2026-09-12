import { test, expect } from "bun:test";
import { startServer } from "./server.mjs";
import { valid } from "./contract.mjs";

test("HTTP server starts with an empty SQLite database and schema-valid discovery", async () => {
  const app = startServer();
  try {
    const response = await fetch(app.url + "/demo/state");
    const state = await response.json();
    expect(response.status).toBe(200);
    expect(state.purchases).toBe(0);
    expect(state.access).toBe(false);
    const capabilities = await fetch(app.url + "/commerce/v1/capabilities");
    const body = await capabilities.json();
    expect(capabilities.status).toBe(200);
    expect(valid("#/$defs/ProviderCapabilities", body)).toBe(true);
  } finally {
    await app.close();
  }
});
