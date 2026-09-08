import assert from "node:assert/strict";
import { operation, validate } from "./contract.mjs";

// Run on the app backend; the provider still authenticates the store evidence.
export function toVerifyPurchaseInput(purchase, context = {}) {
  const { store, purchaseToken } = purchase ?? {};
  let input;
  const required = (value) => {
    if (typeof value !== "string" || !value.trim())
      throw new Error("Purchase evidence is required");
    return value;
  };
  switch (store) {
    case "apple":
      input = { store, apple: { jws: required(purchaseToken) } };
      break;
    case "google":
      input = { store, google: { purchaseToken: required(purchaseToken) } };
      break;
    case "amazon":
      input = {
        store,
        amazon: {
          userId: required(context.storeUserId),
          receiptId: required(purchaseToken),
          ...(context.amazonSandbox === true ? { sandbox: true } : {}),
        },
      };
      break;
    case "horizon":
      input = {
        store,
        horizon: {
          userId: required(context.storeUserId),
          sku: required(purchase.productId),
        },
      };
      break;
    default:
      throw new Error("Unsupported purchase store");
  }
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
  for (const store of ["amazon", "horizon"]) {
    const input = toVerifyPurchaseInput(
      {
        store,
        purchaseToken: "receipt-1",
        productId: "premium.monthly",
        userId: "untrusted-app-user",
      },
      { storeUserId: "authenticated-store-user", amazonSandbox: true },
    );
    assert.deepEqual(
      input,
      store === "amazon"
        ? {
            store,
            amazon: {
              userId: "authenticated-store-user",
              receiptId: "receipt-1",
              sandbox: true,
            },
          }
        : {
            store,
            horizon: {
              userId: "authenticated-store-user",
              sku: "premium.monthly",
            },
          },
    );
    checks.push(
      `${store}: uses server-selected store identity, distinct from the app user`,
    );
    assert(validate(operation("verifyPurchase").input, input));
    checks.push(`${store}: matches the installed verification input schema`);
  }
  for (const [label, purchase] of [
    ["missing purchase", null],
    ["unknown store", { store: "unknown", purchaseToken: "fictional" }],
    [
      "Amazon requires its authenticated store user",
      { store: "amazon", purchaseToken: "fictional" },
    ],
    [
      "Horizon requires its authenticated store user",
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
