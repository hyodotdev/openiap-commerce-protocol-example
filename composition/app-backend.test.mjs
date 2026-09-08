import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProvider, FIXTURE, CREDENTIALS } from "../provider.mjs";
import { startConsumer } from "../consumer.mjs";
import { startAppBackend } from "./app-backend.mjs";

test("account deletion waits for in-flight fulfillment and retries provider erasure after app restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "commerce-app-erasure-"));
  const provider = createProvider(
    join(directory, "provider.sqlite"),
    () => FIXTURE.startsAt,
  );
  let releaseBind, signalBind;
  const binding = new Promise((resolve) => {
    signalBind = resolve;
  });
  const gate = new Promise((resolve) => {
    releaseBind = resolve;
  });
  let rejectErase = true,
    eraseCalls = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname.endsWith("/bind")) {
        signalBind();
        await gate;
      }
      if (new URL(request.url).pathname.endsWith("/erase")) {
        eraseCalls++;
        if (rejectErase) return new Response(null, { status: 503 });
      }
      return provider.fetch(request);
    },
  });
  const receiver = startConsumer({
    path: join(directory, "receiver.sqlite"),
    secret: "fixture-key",
  });
  const options = {
    path: join(directory, "app.sqlite"),
    providers: {
      example: {
        baseUrl: `http://127.0.0.1:${server.port}`,
        credential: CREDENTIALS.server,
      },
    },
    receiver,
    resolveSession: () => FIXTURE.userId,
  };
  let app = startAppBackend(options);
  try {
    const purchase = fetch(app.url + "/purchase", {
      method: "POST",
      body: JSON.stringify({
        store: FIXTURE.store,
        evidence: FIXTURE.evidence,
      }),
    });
    await binding;
    const deletion = fetch(app.url + "/account", { method: "DELETE" });
    for (let i = 0; i < 50; i++) {
      const response = await fetch(app.url + "/access");
      if (response.status === 401) break;
      await Bun.sleep(10);
    }
    expect((await fetch(app.url + "/access")).status).toBe(401);
    let workerFinished = false;
    const background = app.drainErasure().then((pending) => {
      workerFinished = true;
      return pending;
    });
    await Bun.sleep(20);
    expect(workerFinished).toBe(false);
    expect(eraseCalls).toBe(0);
    releaseBind();
    expect(await (await purchase).json()).toEqual({ access: false });
    expect(await (await deletion).json()).toEqual({
      accepted: true,
      status: "queued",
    });
    expect(await background).toBe(1);
    await app.close();
    app = startAppBackend(options);
    expect(
      (await fetch(app.url + "/purchase", { method: "POST", body: "{}" }))
        .status,
    ).toBe(401);
    rejectErase = false;
    expect(await app.drainErasure()).toBe(0);
    expect(provider.inspect().purchases[0].userId).toBeNull();
  } finally {
    releaseBind();
    await app.close();
    await receiver.close();
    await server.stop(true);
    provider.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
