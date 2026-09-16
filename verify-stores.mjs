import assert from "node:assert/strict";
import { createProvider, CREDENTIALS } from "./provider.mjs";
import { operation } from "./contract.mjs";
import { toVerifyPurchaseInput } from "./client-bridge.mjs";

export async function verifyStores() {
  const checks = [];
  for (const store of ["apple", "google", "amazon", "horizon"]) {
    let current = true;
    let time = Date.now();
    const input = toVerifyPurchaseInput(
      { store, purchaseToken: "fictional-proof", productId: "premium.monthly" },
      { storeUserId: "fixture-store-user", amazonSandbox: true },
    );
    const evidence =
      store === "amazon"
        ? JSON.stringify(["fixture-store-user", "fictional-proof", true])
        : store === "horizon"
          ? JSON.stringify(["fixture-store-user", "premium.monthly"])
          : "fictional-proof";
    const fixture = {
      store,
      evidence,
      userId: "alice",
      productId: "premium.monthly",
      startsAt: time,
      expiresAt: time + 60000,
      pointInTime: ["amazon", "horizon"].includes(store),
      currentVerdict: () => current,
    };
    const provider = createProvider(":memory:", () => time, fixture);
    const check = (label, actual, expected) => {
      assert.deepEqual(actual, expected, `${store}: ${label}`);
      checks.push(`${store}: ${label}`);
    };
    async function call(name, body, credential = CREDENTIALS.server) {
      const spec = operation(name),
        url = new URL(spec.path, "http://fixture.invalid");
      if (spec.method === "GET")
        for (const [key, value] of Object.entries(body ?? {}))
          url.searchParams.set(key, value);
      const response = await provider.fetch(
        new Request(url, {
          method: spec.method,
          headers: {
            authorization: credential,
            "content-type": "application/json",
          },
          ...(spec.method === "POST" ? { body: JSON.stringify(body) } : {}),
        }),
      );
      return { status: response.status, result: await response.json() };
    }
    try {
      check(
        "unverified evidence cannot bind",
        (await call("bindPurchase", { ...input, userId: "alice" })).result
          .bound,
        false,
      );
      check(
        "matching evidence verifies",
        (await call("verifyPurchase", input)).result.isValid,
        true,
      );
      check(
        "verification alone gives no access",
        (await call("entitlements", { userId: "alice" })).result.productIds,
        [],
      );
      check(
        "verification credentials cannot bind",
        (
          await call(
            "bindPurchase",
            { ...input, userId: "alice" },
            CREDENTIALS.verification,
          )
        ).status,
        403,
      );
      for (let i = 0; i < 2; i++)
        check(
          "binding and retry keep one owner",
          (await call("bindPurchase", { ...input, userId: "alice" })).result
            .bound,
          true,
        );
      check(
        "another account cannot claim the purchase",
        (await call("bindPurchase", { ...input, userId: "bob" })).result.bound,
        false,
      );
      check(
        "owned product is accessible",
        (await call("entitlements", { userId: "alice" })).result.productIds,
        ["premium.monthly"],
      );
      if (fixture.pointInTime) {
        current = "outage";
        check(
          "an outage is an error, not cached access",
          (await call("entitlements", { userId: "alice" })).status,
          502,
        );
        current = false;
        check(
          "a negative recheck removes access",
          (await call("entitlements", { userId: "alice" })).result.productIds,
          [],
        );
        current = true;
        check(
          "a confirmed recheck restores ownership",
          (await call("entitlements", { userId: "alice" })).result.productIds,
          ["premium.monthly"],
        );
      }
      check(
        "erasure completes",
        (await call("eraseUser", { userId: "alice" })).result.status,
        "completed",
      );
      check(
        "erasure removes access",
        (await call("entitlements", { userId: "alice" })).result.productIds,
        [],
      );
      check(
        "erased evidence cannot be claimed",
        (await call("bindPurchase", { ...input, userId: "bob" })).result.bound,
        false,
      );
      for (const [label, offset] of [
        ["before", -1],
        ["at", 0],
        ["after", 1],
      ]) {
        time = fixture.expiresAt + offset;
        const verdict = (await call("verifyPurchase", input)).result;
        check(
          `verification ${label} the fixture deadline respects the store's access model`,
          [verdict.isValid, verdict.state],
          fixture.pointInTime || offset < 0
            ? [true, "ENTITLED"]
            : [false, "EXPIRED"],
        );
      }
      if (fixture.pointInTime) {
        current = false;
        const rejected = (await call("verifyPurchase", input)).result;
        check(
          "a negative ownership verdict remains rejected after the fixture deadline",
          [rejected.isValid, rejected.state],
          [false, "INAUTHENTIC"],
        );
        current = "outage";
        check(
          "an ownership verification outage remains an error after the fixture deadline",
          (await call("verifyPurchase", input)).status,
          502,
        );
      }
    } finally {
      provider.close();
    }
  }
  return checks;
}
if (import.meta.main)
  console.log(
    `Store fixtures: ${(await verifyStores()).length} checks passed. No store contacted.`,
  );
