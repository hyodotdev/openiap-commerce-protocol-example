# Connect your paywall to experiment data

Keep the paywall and experiment assignment in your app. Let a purchase backend
check the purchase, then send Commerce Protocol events to your analytics service.
This example adds that connection to the backend built in the first seven commits.

## Run and see the result

Install Bun and Node.js/npm. In this example's folder:

```sh
npm ci
npm test
PORT=5198 npm start
```

Open `http://127.0.0.1:5198/paywall`.

| Click | What you will see |
| --- | --- |
| Apple fixture → Buy Premium → Deliver events | Premium opens. Two events arrive; the purchase contributes a fictional USD 4.99 to Onboarding / A. |
| Simulate renewal → Deliver events | Another purchase observation brings the known amount to USD 9.98. |
| Cancel renewal → Deliver events | Premium stays open. The known amount remains USD 9.98. |
| Google fixture → Buy Premium → Deliver events | The same receiver joins the purchase to Onboarding / B. Its amount is unknown, not zero. |
| Redeliver saved events, for each store | Event count and amounts stay unchanged. |

Expand the HTTP exchange to inspect the actual destination, request, and response.
Stop and restart the server: the received events and experiment assignments stay
in SQLite. A fresh checkout starts empty. Use `DATA_DIR=.runtime/another-run` for
a separate local database; use `PORT` for a different port.

## Ask AI to implement your connection

Run `npx @hyodotdev/openiap init --role experience` in your existing product
(`--role data` for an event receiver). Paste its entire output into the coding
assistant's chat for that same project, then append:

```text
Keep our existing paywall, experiment assignments, and purchase callback.
Connect our app backend to the chosen commerce provider. Fulfill and finish only
after the backend grants the selected product. If we also own analytics, join
signed lifecycle events to our existing customer and experiment mapping.
Keep unknown amounts unknown, preserve currencies, and deduplicate by event ID
in the authenticated emitter/project scope. Show cancellation and redelivery.
Use PAYWALL.md and paywall.test.mjs from the example as acceptance references.
Run the example separately, then run equivalent checks against OUR changed code.
Show our running result, commands, failures and corrections, and untested parts.
```

The CLI prints context; the coding assistant implements the connection. Your
decisions are the store, provider, authentication/account mapping, and experiment
attribution policy. A paywall-only product can leave analytics to another service.

## Follow one purchase through the code

| Responsibility | Example code | Boundary |
| --- | --- | --- |
| Paywall and simulated host callback | [paywall.html](paywall.html), [paywall.mjs](paywall.mjs) | `/paywall/*` is this app's demo interface. It is not a protocol API. |
| Purchase verification, ownership and access | [server.mjs](server.mjs), [backend.mjs](backend.mjs) | Actual local requests to `/commerce/v1/purchases/verify`, `/purchases/bind`, and `/entitlements`. |
| Subscription changes | [backend.mjs](backend.mjs) | `/fixture/renew` and `/fixture/cancel` simulate store observations. They are not public protocol operations. |
| Signed delivery and durable inbox | [delivery.mjs](delivery.mjs) | The producer sends the same CommerceEvent envelope to `/webhooks/commerce` over local HTTP. |
| Experiment association and reporting | [attribution.mjs](attribution.mjs) | Product-owned join keyed by project, store, environment, purchase chain and bound user. No experiment fields are added to the protocol. |
| Customer outcomes and failure cases | [paywall.test.mjs](paywall.test.mjs) | Also rejects tampering, handles missing amounts/currencies, preserves mappings on reopen, and erases them with the customer. |

The host's fixture catalog supplies the purchase-chain/account association. In
your product, derive that association from authenticated purchase records; never
trust an experiment or customer identifier merely because the client sent it.
This sample fixes the first assignment for one subscription chain. Your product
chooses its attribution window, cross-device identity and experiment policy.

## What the amount means

The projection records positive `subscription.started` and `subscription.renewed`
observations with store-provenance prices, grouped by currency and experiment.
The Apple fixture explicitly simulates such a price; no store asserted real money.
The Google fixture intentionally omits price. That omission illustrates an absent
field; it is not a claim about everything that store can report.

Event IDs deduplicate deliveries. Transaction IDs remain reference data, not a
second event deduplication key. Cancellation and entitlement changes add no
charge. Missing, catalog, and inferred prices stay unknown for this projection.
Refunds and recoveries are marked for reconciliation; the event's price is not a
refund amount. These totals are fictional gross observations, not net revenue,
MRR, ARPU, a refund ledger, or complete financial reporting.

## Compare an independent implementation

IAPKit's [payload builder](https://github.com/hyodotdev/openiap/blob/main/packages/kit/convex/commerce/deliveryState.ts),
[schema checks](https://github.com/hyodotdev/openiap/blob/main/packages/kit/convex/commerce/spec.conformance.test.ts),
and [delivery checks](https://github.com/hyodotdev/openiap/blob/main/packages/kit/convex/commerce/delivery.test.ts)
cover the equivalent envelope, missing-price and delivery boundaries. It uses
store adapters, tenant credentials, and production delivery machinery. This
extension reuses the small local backend and receiver. Those source references
are a comparison, not a new execution or provider-swapping result.

## Verification scope

This was an iterative AI extension of the existing example with conversation
context. It is not an independent one-prompt trial. Apple and Google receipts,
identity, clock, amounts and store outcomes are fixtures. Real local HTTP,
SQLite, signatures and application joins execute. It verifies neither a real
store checkout nor integration with an external paywall/analytics product.
It does not add a production events-profile or GraphQL conformance claim.

The first full run caught an invalid capability declaration. The
[failed output](evidence/paywall-first-run.json) is retained; the declaration was
corrected without dropping a test or profile. [Final test output](evidence/paywall-tests.json)
includes the original regression suite and the new connection tests.
