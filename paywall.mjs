import { PAYWALL_STORES } from "./paywall-fixtures.mjs";
import { PRODUCT } from "./backend.mjs";
import { manifest, valid } from "./contract.mjs";

export async function handlePaywall(request, app) {
  const url = new URL(request.url);
  const stores = app.stores ?? PAYWALL_STORES;
  const provider = app.provider;
  const trace = [];
  async function call(path, body, method = "POST") {
    const destination = new URL(path, provider.baseUrl).href;
    const response = await fetch(destination, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${provider.credential}`,
      },
      ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    });
    const data = await response.json();
    trace.push({
      method,
      destination,
      input: body,
      status: response.status,
      response: data,
    });
    if (!response.ok) throw Error(`Request failed: ${path}`);
    const operation = manifest.operations.find(
      (item) => item.path === path.split("?")[0] && item.method === method,
    );
    if (
      path.startsWith("/commerce/") &&
      (!operation || !valid(operation.result, data))
    )
      throw Error(`Invalid provider response: ${path}`);
    return data;
  }
  if (url.pathname === "/paywall" && request.method === "GET")
    return new Response(Bun.file(new URL("./paywall.html", import.meta.url)), {
      headers: { "Content-Type": "text/html" },
    });
  if (url.pathname === "/paywall/state" && request.method === "GET")
    return Response.json({
      stores: await Promise.all(
        stores.map(async (sample) => ({
          id: sample.id,
          label: sample.label,
          variant: sample.variant,
          access: (
            await call(
              "/commerce/v1/entitlements?userId=" +
                encodeURIComponent(sample.userId),
              undefined,
              "GET",
            )
          ).productIds.includes(sample.productId ?? PRODUCT),
        })),
      ),
      report: app.attribution.report(),
      receiver: app.receiver.url,
    });
  if (
    !/^\/paywall\/(buy|renew|cancel|deliver|redeliver)$/.test(url.pathname) ||
    request.method !== "POST"
  )
    return new Response(null, { status: 404 });
  if (
    request.headers.get("origin") &&
    request.headers.get("origin") !== url.origin
  )
    return new Response(null, { status: 403 });
  let input;
  try {
    input = await request.json();
  } catch {
    return new Response(null, { status: 400 });
  }
  const sample = stores.find((item) => item.id === input?.store);
  if (!sample) return new Response(null, { status: 400 });
  if (app.backend?.erased(sample.userId) || app.receiver.erased(sample.userId))
    return new Response(null, { status: 403 });
  let result = "completed";
  let finishCalls = 0;
  if (url.pathname === "/paywall/buy") {
    const outcome = input.outcome ?? "success";
    if (!["success", "pending", "canceled", "failed"].includes(outcome))
      return new Response(null, { status: 400 });
    result = outcome;
    if (outcome === "success") {
      const verified = await call(
        "/commerce/v1/purchases/verify",
        sample.receipt,
      );
      if (!verified.isValid) result = "failed";
      else {
        const bound = await call("/commerce/v1/purchases/bind", {
          ...sample.receipt,
          userId: sample.userId,
        });
        const access = await call(
          "/commerce/v1/entitlements?userId=" +
            encodeURIComponent(sample.userId),
          undefined,
          "GET",
        );
        result =
          bound.bound && access.productIds.includes(sample.productId ?? PRODUCT)
            ? "fulfilled"
            : "failed";
        if (result === "fulfilled") {
          if (app.assign) app.assign(sample);
          else app.attribution.assign(sample);
          finishCalls = 1;
        }
      }
    }
  } else if (
    url.pathname === "/paywall/renew" ||
    url.pathname === "/paywall/cancel"
  ) {
    await call(
      url.pathname === "/paywall/renew" ? "/fixture/renew" : "/fixture/cancel",
      { userId: sample.userId },
    );
    await call(
      "/commerce/v1/entitlements?userId=" + encodeURIComponent(sample.userId),
      undefined,
      "GET",
    );
  } else {
    if (url.pathname === "/paywall/redeliver")
      app.backend.db
        .query(
          "UPDATE outbox SET status='pending',attempts=0,next_attempt=0 WHERE user_id=?",
        )
        .run(sample.userId);
    trace.push(...(await app.delivery.drain()));
  }
  return Response.json({ result, finishCalls, trace });
}
