import { startReceiver, createDelivery } from "./delivery.mjs";
import { openAttribution, eraseAttribution } from "./attribution.mjs";
import { handlePaywall } from "./paywall.mjs";
import { mkdirSync } from "node:fs";
import { openBackend, END } from "./backend.mjs";
import {
  manifest,
  valid,
  failure,
  result,
  ProtocolFault,
} from "./contract.mjs";

export const CREDENTIALS = {
  verification: "fixture-verification",
  server: "fixture-server",
};
export function startServer({
  path = ":memory:",
  port = 0,
  receiverPath = ":memory:",
  clock = Date.now,
} = {}) {
  const backend = openBackend(path);
  const receiver = startReceiver({
    path: receiverPath,
    clock,
    onErase: eraseAttribution,
  });
  const attribution = openAttribution(receiver.db);
  const delivery = createDelivery(backend, receiver.url, { clock });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    maxRequestBodySize: 32768,
    async fetch(request) {
      try {
        const url = new URL(request.url);
        if (url.pathname.startsWith("/paywall"))
          return await handlePaywall(request, {
            backend,
            receiver,
            delivery,
            attribution,
            serverCredential: CREDENTIALS.server,
          });
        if (url.pathname === "/" && request.method === "GET")
          return new Response(
            Bun.file(new URL("./dashboard.html", import.meta.url)),
            { headers: { "Content-Type": "text/html" } },
          );
        if (url.pathname === "/demo/state" && request.method === "GET")
          return Response.json({
            ...backend.state(
              url.searchParams.get("user") === "bob" ? "bob" : "alice",
            ),
            inbox: receiver.db.query("SELECT count(*) n FROM inbox").get().n,
          });
        if (
          [
            "/demo/verify",
            "/demo/bind",
            "/demo/cancel",
            "/demo/deliver",
            "/demo/expire",
            "/demo/erase",
          ].includes(url.pathname) &&
          request.method === "POST"
        ) {
          if (
            request.headers.get("origin") &&
            request.headers.get("origin") !== url.origin
          )
            return failure("FORBIDDEN");
          let body;
          try {
            body = await request.json();
          } catch {
            return failure("INVALID_REQUEST");
          }
          const userId = body.user === "bob" ? "bob" : "alice";
          if (backend.erased(userId) && url.pathname !== "/demo/erase")
            return failure("FORBIDDEN");
          const trace = [];
          async function call(path, input, method = "POST") {
            const response = await fetch(server.url.origin + path, {
              method,
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${CREDENTIALS.server}`,
              },
              ...(method === "POST" ? { body: JSON.stringify(input) } : {}),
            });
            const data = await response.json();
            trace.push({
              method,
              path,
              ...(method === "POST" ? { input } : {}),
              status: response.status,
              response: data,
            });
            return data;
          }
          const input = {
            store: "fixture",
            fixture: { receipt: "alice-monthly" },
          };
          if (url.pathname === "/demo/verify")
            await call("/commerce/v1/purchases/verify", input);
          else if (url.pathname === "/demo/bind") {
            await call("/commerce/v1/purchases/bind", { ...input, userId });
            await call(
              "/commerce/v1/entitlements?userId=" + userId,
              undefined,
              "GET",
            );
          }
          if (url.pathname === "/demo/cancel") {
            await call("/fixture/cancel", { userId });
            await call(
              "/commerce/v1/subscriptions/status?userId=" + userId,
              undefined,
              "GET",
            );
          }
          if (url.pathname === "/demo/erase") {
            await call("/fixture/erase-receiver", { userId });
            await call("/commerce/v1/users/erase", { userId });
            await call(
              "/commerce/v1/entitlements?userId=" + userId,
              undefined,
              "GET",
            );
          }
          if (url.pathname === "/demo/expire") {
            await call("/fixture/clock", { now: END });
            await call(
              "/commerce/v1/entitlements?userId=" + userId,
              undefined,
              "GET",
            );
            await call("/fixture/expire", { userId });
          }
          if (url.pathname === "/demo/deliver") {
            receiver.state.failNext = true;
            trace.push(...(await delivery.drain()));
          }
          return Response.json({ trace });
        }
        if (
          [
            "/fixture/cancel",
            "/fixture/renew",
            "/fixture/clock",
            "/fixture/expire",
            "/fixture/erase-receiver",
          ].includes(url.pathname) &&
          request.method === "POST"
        ) {
          if (
            request.headers.get("authorization") !==
            `Bearer ${CREDENTIALS.server}`
          )
            return failure("UNAUTHORIZED");
          let input;
          try {
            input = await request.json();
          } catch {
            return failure("INVALID_REQUEST");
          }
          if (url.pathname === "/fixture/clock")
            return Response.json(backend.setClock(input?.now));
          if (!valid("#/$defs/SubscriptionStatusInput", input))
            return failure("INVALID_REQUEST");
          if (url.pathname === "/fixture/erase-receiver")
            return Response.json(receiver.erase(input.userId));
          if (url.pathname === "/fixture/renew")
            return Response.json(backend.renew(input.userId));
          return Response.json(
            url.pathname === "/fixture/expire"
              ? backend.expire(input.userId)
              : backend.cancel(input.userId),
          );
        }
        const operation = manifest.operations.find(
          (op) => op.path === url.pathname && op.method === request.method,
        );
        if (!operation) return failure("NOT_FOUND");
        if (operation.name === "providerCapabilities")
          return result(operation, backend.capabilities());
        const credential = request.headers.get("authorization");
        const role = Object.keys(CREDENTIALS).find(
          (key) => credential === `Bearer ${CREDENTIALS[key]}`,
        );
        if (!role) return failure("UNAUTHORIZED");
        if (operation.auth === "server" && role !== "server")
          return failure("FORBIDDEN");
        let input;
        if (operation.method === "POST") {
          if (
            !request.headers.get("content-type")?.startsWith("application/json")
          )
            return failure("INVALID_REQUEST");
          try {
            input = await request.json();
          } catch {
            return failure("INVALID_REQUEST");
          }
        } else input = Object.fromEntries(url.searchParams);
        if (operation.input && !valid(operation.input, input))
          return failure("INVALID_REQUEST");
        if (operation.name === "verifyPurchase")
          return result(operation, backend.verify(input));
        if (operation.name === "eraseUser")
          return result(operation, backend.erase(input.userId));
        if (operation.name === "bindPurchase")
          return result(operation, backend.bind(input));
        if (operation.name === "entitlements")
          return result(operation, backend.entitlements(input));
        if (operation.name === "subscriptionStatus")
          return result(operation, backend.status(input));
        return failure("UNSUPPORTED_PROFILE");
      } catch (error) {
        return failure(
          error instanceof ProtocolFault ? error.code : "INTERNAL_ERROR",
        );
      }
    },
  });
  return {
    server,
    backend,
    receiver,
    delivery,
    attribution,
    url: server.url.origin,
    async close() {
      await server.stop(true);
      await receiver.close();
      backend.close();
    },
  };
}
if (import.meta.main) {
  const directory = process.env.DATA_DIR ?? ".runtime";
  mkdirSync(directory, { recursive: true });
  const app = startServer({
    path: `${directory}/provider.sqlite`,
    receiverPath: `${directory}/receiver.sqlite`,
    port: Number(process.env.PORT ?? 5196),
  });
  console.log(`Commerce Protocol from scratch: ${app.url}`);
  process.on("SIGINT", async () => {
    await app.close();
    process.exit(0);
  });
  process.on("SIGTERM", async () => {
    await app.close();
    process.exit(0);
  });
}
