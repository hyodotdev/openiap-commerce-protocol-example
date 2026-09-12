import { PAYWALL_STORES } from "./paywall-fixtures.mjs";
import { PRODUCT } from "./backend.mjs";

export async function handlePaywall(request, app) {
  const url = new URL(request.url);
  if (url.pathname === "/paywall" && request.method === "GET")
    return new Response(Bun.file(new URL("./paywall.html", import.meta.url)), {
      headers: { "Content-Type": "text/html" },
    });
  if (url.pathname === "/paywall/state" && request.method === "GET")
    return Response.json({
      stores: PAYWALL_STORES.map((sample) => ({
        id: sample.id,
        label: sample.label,
        variant: sample.variant,
        access: app.backend.status({ userId: sample.userId }).active,
      })),
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
  const sample = PAYWALL_STORES.find((item) => item.id === input?.store);
  if (!sample) return new Response(null, { status: 400 });
  if (app.backend.erased(sample.userId) || app.receiver.erased(sample.userId))
    return new Response(null, { status: 403 });
  const trace = [];
  async function call(path, body, method = "POST") {
    const response = await fetch(url.origin + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${app.serverCredential}`,
      },
      ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
    });
    const data = await response.json();
    trace.push({
      method,
      destination: url.origin + path,
      input: body,
      status: response.status,
      response: data,
    });
    if (!response.ok) throw Error(`Request failed: ${path}`);
    return data;
  }
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
          "/commerce/v1/entitlements?userId=" + sample.userId,
          undefined,
          "GET",
        );
        result =
          bound.bound && access.productIds.includes(PRODUCT)
            ? "fulfilled"
            : "failed";
        if (result === "fulfilled") {
          app.attribution.assign(sample);
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
      "/commerce/v1/entitlements?userId=" + sample.userId,
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
