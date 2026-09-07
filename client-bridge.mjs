import assert from "node:assert/strict";
import { operation, validate } from "./contract.mjs";

// Run on the app backend; the provider still authenticates the store evidence.
export function toVerifyPurchaseInput(purchase) {
  const { store, purchaseToken } = purchase ?? {};
  if (!["apple", "google"].includes(store))
    throw new Error("This adapter supports Apple and Google purchases only");
  if (typeof purchaseToken !== "string" || !purchaseToken.trim())
    throw new Error("Purchase evidence is required");
  const input = {
    store,
    ...(store === "apple"
      ? { apple: { jws: purchaseToken } }
      : { google: { purchaseToken } }),
  };
  if (!validate(operation("verifyPurchase").input, input))
    throw new Error("Purchase evidence does not match the protocol input");
  return input;
}

export function runBridgeDemo() {
  const checks = [];
  for (const store of ["apple", "google"]) {
    const token = `fictional-${store}-evidence`;
    const input = toVerifyPurchaseInput({
      store,
      purchaseToken: token,
      productId: "premium.monthly",
      userId: "untrusted-client-claim",
    });
    assert.deepEqual(input, {
      store,
      ...(store === "apple"
        ? { apple: { jws: token } }
        : { google: { purchaseToken: token } }),
    });
    checks.push(`${store}: maps evidence without forwarding client identity`);
    assert(validate(operation("verifyPurchase").input, input));
    checks.push(`${store}: matches the installed verification input schema`);
  }
  for (const [label, purchase] of [
    ["missing purchase", null],
    ["unknown store", { store: "unknown", purchaseToken: "fictional" }],
    [
      "Amazon needs its own adapter",
      { store: "amazon", purchaseToken: "fictional" },
    ],
    [
      "Horizon needs its own adapter",
      { store: "horizon", purchaseToken: "fictional" },
    ],
    ["missing evidence", { store: "apple" }],
    ["blank evidence", { store: "google", purchaseToken: " " }],
    ["non-string evidence", { store: "apple", purchaseToken: 123 }],
    [
      "oversized evidence",
      { store: "apple", purchaseToken: "x".repeat(16385) },
    ],
  ]) {
    assert.throws(() => toVerifyPurchaseInput(purchase), Error);
    checks.push(`Rejects ${label}`);
  }
  return checks;
}

if (import.meta.main)
  console.log(
    `Client boundary: ${runBridgeDemo().length} checks passed against the installed contract. Fixture fields only; no SDK checkout or store contacted.`,
  );
