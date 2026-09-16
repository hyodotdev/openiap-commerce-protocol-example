// Host callbacks are integration-specific; this is not a protocol paywall API.
export function createPurchaseFlow({ purchase, fulfill, finish }) {
  let busy = false;
  return async function select(productId) {
    if (busy) return { status: "busy" };
    busy = true;
    try {
      const result = await purchase(productId);
      if (result.status === "pending" || result.status === "canceled")
        return { status: result.status };
      if (result.status !== "purchased") throw new Error("Purchase failed");
      const access = await fulfill(result.evidence, productId);
      try {
        await finish(result);
      } catch {
        return { status: "finish-pending", access };
      }
      return { status: "fulfilled", access };
    } catch {
      return { status: "failed" };
    } finally {
      busy = false;
    }
  };
}
