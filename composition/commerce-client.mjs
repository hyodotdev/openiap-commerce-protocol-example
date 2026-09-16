import { operation, validate } from "../contract.mjs";

// This module runs on the authenticated app backend, which owns the credential.
export function createCommerceClient({ baseUrl, credential }) {
  async function call(name, input) {
    const spec = operation(name);
    if (!spec) throw new Error("Unknown operation");
    if (spec.input && !validate(spec.input, input))
      throw new Error("Invalid operation input");
    const url = new URL(spec.path, baseUrl);
    if (spec.method === "GET" && input)
      for (const [key, value] of Object.entries(input))
        url.searchParams.set(key, value);
    const response = await fetch(url, {
      method: spec.method,
      headers: {
        "content-type": "application/json",
        ...(spec.auth === "none" ? {} : { authorization: credential }),
      },
      ...(spec.method === "POST" ? { body: JSON.stringify(input) } : {}),
      redirect: "error",
      signal: AbortSignal.timeout(5000),
    });
    const result = await response.json();
    if (response.status !== spec.successStatus)
      throw new Error("Commerce operation failed");
    if (!validate(spec.result, result))
      throw new Error("Invalid operation result");
    return result;
  }

  async function fulfill(input, { userId, productId }) {
    const evidence = { ...input };
    delete evidence.userId;
    const verdict = await call("verifyPurchase", evidence);
    if (!verdict.isValid) throw new Error("Purchase was not accepted");
    const binding = await call("bindPurchase", { ...evidence, userId });
    if (!binding.bound) throw new Error("Purchase belongs to another user");
    const access = await call("entitlements", { userId });
    if (!access.productIds.includes(productId))
      throw new Error("Requested product is not accessible");
    return access;
  }

  return { call, fulfill };
}
