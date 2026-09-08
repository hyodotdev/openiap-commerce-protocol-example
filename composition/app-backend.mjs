import { Database } from "bun:sqlite";
import { createCommerceClient } from "./commerce-client.mjs";
import { createErasureLedger } from "../erasure.mjs";

// resolveSession is the host app's authentication boundary, supplied by the caller.
export function startAppBackend({
  path,
  providers,
  receiver,
  resolveSession,
  resolveStoreUser,
}) {
  const db = new Database(path, { create: true });
  db.exec(
    "CREATE TABLE IF NOT EXISTS erasure_requests (user_id TEXT, provider TEXT, PRIMARY KEY(user_id, provider))",
  );
  const erased = createErasureLedger(db);
  const clients = Object.fromEntries(
    Object.entries(providers).map(([name, config]) => [
      name,
      createCommerceClient(config),
    ]),
  );
  const inFlight = new Map();
  let selected = Object.keys(clients)[0];
  async function drainErasure() {
    for (const row of db.query("SELECT * FROM erasure_requests").all()) {
      try {
        receiver.eraseUser(row.user_id);
        await Promise.allSettled([...(inFlight.get(row.user_id) ?? [])]);
        const result = await clients[row.provider].call("eraseUser", {
          userId: row.user_id,
        });
        if (result.accepted && result.status === "completed")
          db.query(
            "DELETE FROM erasure_requests WHERE user_id = ? AND provider = ?",
          ).run(row.user_id, row.provider);
      } catch {
        /* The durable request is retried by the app's worker. */
      }
    }
    return db.query("SELECT count(*) AS count FROM erasure_requests").get()
      .count;
  }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    maxRequestBodySize: 32768,
    async fetch(request) {
      const userId = await resolveSession(request);
      if (!userId || erased.has(userId))
        return new Response("Unauthenticated", { status: 401 });
      const url = new URL(request.url);
      try {
        if (url.pathname === "/purchase" && request.method === "POST") {
          const input = await request.json();
          if (erased.has(userId))
            return new Response("Unauthenticated", { status: 401 });
          if (input.store === "amazon" || input.store === "horizon") {
            const storeUser = await resolveStoreUser?.(request, input.store);
            if (!storeUser || input[input.store]?.userId !== storeUser)
              return new Response(
                "Store account is not linked to this session",
                { status: 403 },
              );
          }
          if (erased.has(userId))
            return new Response("Unauthenticated", { status: 401 });
          const work = clients[selected].fulfill(input, {
            userId,
            productId: "premium.monthly",
          });
          const pending = inFlight.get(userId) ?? new Set();
          pending.add(work);
          inFlight.set(userId, pending);
          let result;
          try {
            result = await work;
          } finally {
            pending.delete(work);
            if (!pending.size) inFlight.delete(userId);
          }
          // A deletion can race the upstream calls; never return access afterwards.
          return Response.json(erased.has(userId) ? { access: false } : result);
        }
        if (url.pathname === "/access" && request.method === "GET") {
          const result = await clients[selected].call("entitlements", {
            userId,
          });
          return erased.has(userId)
            ? new Response("Unauthenticated", { status: 401 })
            : Response.json(result);
        }
        if (url.pathname === "/account" && request.method === "DELETE") {
          db.transaction(() => {
            erased.remember(userId);
            for (const name of Object.keys(clients))
              db.query(
                "INSERT OR IGNORE INTO erasure_requests VALUES (?,?)",
              ).run(userId, name);
          })();
          receiver.eraseUser(userId);
          const pending = await drainErasure();
          return Response.json({
            accepted: true,
            status: pending ? "queued" : "completed",
          });
        }
        return new Response("Not found", { status: 404 });
      } catch {
        return Response.json(
          { error: "Commerce provider unavailable; retry the request." },
          { status: 503 },
        );
      }
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    select(name) {
      if (!clients[name]) throw new Error("Unknown provider");
      selected = name;
    },
    drainErasure,
    async close() {
      await server.stop(true);
      db.close();
    },
  };
}
