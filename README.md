# Commerce Protocol: from an empty folder

An AI builds a local Premium purchase backend from the published contract,
then runs each milestone before committing it. Start at the initial commit
and follow the history to see the input, implementation, failures, and results.

This initial commit contains the captured CLI output, actual docs prompt,
published build/integration briefs, and installed contract. No backend has
been implemented yet. `openiap init` printed instructions; it wrote no code.

Read [the actual AI input](evidence/ai-input.md). This run starts with no
application source and does not copy the earlier example's implementation.
The same assistant has prior context: this is not an independent model trial
or a claim that a single prompt always succeeds. Tests and screenshots will
be recorded from the code that exists at each milestone.

Runtime choice: Bun 1.3.13, HTTP/JSON, SQLite, a fictional monthly subscription,
and fictional Alice/Bob sessions. The protocol package supplies schemas,
bindings, and portable tests. It supplies no running purchase backend.

## Step 1: start the server

```sh
npm ci
npm test
npm start
```

Open `http://127.0.0.1:5196`. The server owns an empty SQLite database in
`.runtime/`. Purchase actions are disabled because they are not implemented.
Discovery returns `INTERNAL_ERROR` while the provider is incomplete; it does
not pretend to serve a protocol profile. Next, build purchase verification.

[Actual test output](evidence/01-server.json) · [Running screen](evidence/01-screen.png)

## Step 2: verify a receipt

Click **Verify sample receipt**. The dashboard's server sends
`POST /commerce/v1/purchases/verify` with the displayed fixture input.
`isValid: true` saves one purchase; repeating it still saves one.
Ownership and access are not implemented at this checkpoint.
The open `fixture` store extension uses `fixture.receipt`; it is not an Apple
or Google receipt format. `not-a-receipt` returns `isValid: false`, while
`outage` returns HTTP 502 because no verdict could be obtained.

[Actual tests](evidence/02-verification.json) · [Screen and response](evidence/02-screen.png)

## Step 3: connect the purchase to Alice

Select Alice and click **Connect purchase to customer**. The app-facing fixture
handler selects the customer, sends `POST /commerce/v1/purchases/bind`, then
`GET /commerce/v1/entitlements?userId=alice`. `bound: true` and
`productIds: ["premium.monthly"]` open Premium. Select Bob and repeat: the
existing ownership stays with Alice and Bob receives no access.

The customer selector is a fictional session switch, not authentication.
Provider credentials stay in `server.mjs`; the browser calls the demo gateway.
Tests also race both claims, reject verification-role account access, and check
that status/entitlement replies contain no receipt.

[Actual tests](evidence/03-ownership.json) · [Working access](evidence/03-screen.png)

## Step 4: cancel renewal, keep paid time

Click **Cancel renewal**. `/fixture/cancel` simulates the store observation;
it is a demo control, not a Commerce Protocol cancellation API. Then the
server reads `/commerce/v1/subscriptions/status`: `willRenew: false` with
`active: true`. Cancellation does not remove the time Alice already paid for.

The provider writes the observation, changed purchase, and immutable event in
one SQLite transaction. An injected write failure rolls all three back. Repeating
the observation produces no second cancellation event. Delivery is next.

[Actual tests including rollback](evidence/04-lifecycle.json) · [Cancellation result](evidence/04-screen.png)

## Step 5: deliver an event to another server

Click **Deliver queued events**. A separate loopback HTTP receiver deliberately
returns 503 once; the sender waits for backoff and retries. The response panel
shows both real attempts, their stable event/delivery IDs, and fresh signatures.
The receiver inserts the authenticated event into SQLite before acknowledging.

Tests reproduce the published signature vectors, tampering, a lost acknowledgement,
no duplicate inbox effect, and a four-attempt dead-letter limit. Both HTTP
servers run locally. Loopback delivery is an explicit fixture exception, so this
checkpoint does not advertise the production `events` profile.

[Actual tests](evidence/05-delivery.json) · [Delivery screen](evidence/05-screen.png)

## Step 6: expire access and restart

Click **Move to the expiry date**. The demo advances its clock, reads access
before applying the expiry observation, then records that observation. At the
exact deadline, `productIds: []` closes Premium; no event delivery is needed
for the synchronous gate to close.

The process test starts this server in a fresh directory, buys and cancels,
then sends `SIGKILL` while an event is still pending. A new process reads the
same databases, retains ownership and inbox entries, and delivers the pending
event. Another abrupt restart after the clock reaches expiry keeps access off.
This proves that specific local recovery path, not all operating-system or
production recovery scenarios.

[Actual process and boundary tests](evidence/06-recovery.json) · [Expiry screen](evidence/06-screen.png)

## Step 7: erase the account

Click **Erase selected test account**. The demo separately erases the app-owned
receiver inbox and calls `POST /commerce/v1/users/erase` on the provider. Access
is empty afterward. The provider cannot remove a copy already delivered to
another service, which is why the caller performs both actions.

Tests cover erasure during an in-flight HTTP delivery, repetition after reopening
both databases, late signed events, rejected old sessions, retained Bob access,
and refusal to attach Alice's retired purchase to another account. Tombstones
are retained as enforcement markers; this is not a claim of forensic database
scrubbing, backup deletion, or production privacy compliance.

The first portable conformance run failed because the custom fixture store was
not exercisable by the published 1.0 runner. A Google-shaped fixture adapter was
then implemented and tested; all earlier tests remain. The descriptor explicitly
identifies simulated behavior, not a real Google integration. The passing run
covers the declared REST verification, entitlements, and accountLifecycle
profiles. Signing vectors and local retry tests are separate from the full
production events profile; GraphQL and real stores are not claimed.

[Failed run](evidence/07-first-conformance.json) · [Source patch at that failure](evidence/07-first-attempt.patch)
· [Passing tests](evidence/07-final.json) · [Erasure screen](evidence/07-screen.png)
