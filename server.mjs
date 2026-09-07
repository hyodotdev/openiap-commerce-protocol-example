import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createProvider, FIXTURE } from "./provider.mjs";
import { createReceiver } from "./webhooks.mjs";
import { createScenario, STAGES } from "./scenario.mjs";

export function startLab({ port = 0 } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "commerce-example-"));
  const runtime = {
    time: FIXTURE.startsAt,
    secret: randomBytes(32).toString("hex"),
    now: () => runtime.time,
    restart() {
      runtime.provider?.close();
      runtime.receiver?.close();
      runtime.provider = createProvider(
        join(directory, "provider.sqlite"),
        runtime.now,
      );
      runtime.receiver = createReceiver(
        join(directory, "receiver.sqlite"),
        runtime.secret,
        runtime.now,
      );
    },
    post: (init) =>
      fetch(`${runtime.baseUrl}/demo/receiver`, {
        ...init,
        redirect: "manual",
        signal: AbortSignal.timeout(5000),
      }),
  };
  runtime.restart();
  let advancing = false;
  const scenario = createScenario(runtime);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    maxRequestBodySize: 64 * 1024,
    async fetch(request) {
      const url = new URL(request.url);
      const origin = request.headers.get("origin");
      if (
        url.origin !== runtime.baseUrl ||
        (origin && origin !== runtime.baseUrl)
      )
        return new Response("Local requests only", { status: 403 });
      if (url.pathname.startsWith("/commerce/v1/"))
        return runtime.provider.fetch(request);
      if (url.pathname === "/demo/receiver" && request.method === "POST")
        return runtime.receiver.fetch(request);
      if (url.pathname === "/demo/state" && request.method === "GET")
        return Response.json({ stages: STAGES, history: scenario.history });
      if (url.pathname === "/demo/advance" && request.method === "POST") {
        if (advancing) return new Response("Step running", { status: 409 });
        advancing = true;
        try {
          return Response.json(await scenario.advance());
        } finally {
          advancing = false;
        }
      }
      if (url.pathname === "/" && request.method === "GET")
        return new Response(
          Bun.file(new URL("./dashboard.html", import.meta.url)),
        );
      return new Response("Not found", { status: 404 });
    },
  });
  runtime.baseUrl = `http://127.0.0.1:${server.port}`;
  return {
    runtime,
    scenario,
    directory,
    async close() {
      await server.stop(true);
      runtime.provider.close();
      runtime.receiver.close();
    },
  };
}

if (import.meta.main) {
  const lab = startLab({ port: Number(process.env.COMMERCE_LAB_PORT ?? 5181) });
  console.log(
    `Commerce Protocol Example: ${lab.runtime.baseUrl}\nDisposable SQLite files: ${lab.directory}\nFictional fixture store. No payments, credentials, or external services required.`,
  );
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, async () => {
      await lab.close();
      process.exit(0);
    });
}
