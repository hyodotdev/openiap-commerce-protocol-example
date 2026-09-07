# Connect an event consumer

Use this receiver when your product needs commerce events without owning store
verification or user accounts. It authenticates raw request bytes, validates the
payload, and saves each event once in SQLite before acknowledging delivery.

## Check the complete local flow

From the example project, after installing dependencies:

```sh
npm run demo:consumer
```

The command starts a temporary receiver, sends seven fictional lifecycle and
entitlement events, repeats each event, tries a tampered body, and reopens the
inbox. Expect HTTP 200 for accepted/repeated deliveries, HTTP 401 for tampering,
and seven inbox records. The command exits nonzero if a check fails.

[consumer-run.json](build/consumer-run.json) records the actual responses and
source hashes. A public Host header is included to exercise proxy forwarding;
the check itself uses local HTTP, not a deployed HTTPS proxy.

## Keep a receiver running

Obtain the signing secret from your chosen emitter. Configure it in the server
process environment; do not put it in the mobile app or commit it to Git.

| Setting                   | Meaning                                                             |
| ------------------------- | ------------------------------------------------------------------- |
| `COMMERCE_WEBHOOK_SECRET` | Required shared signing secret                                      |
| `COMMERCE_INBOX_PATH`     | SQLite file; defaults to `consumer.sqlite` in the working directory |

```sh
# Set COMMERCE_WEBHOOK_SECRET through your server environment first.
COMMERCE_INBOX_PATH=/path/to/persistent/inbox.sqlite npm run consumer
```

The parent directory must exist and be writable. Configure your HTTPS reverse
proxy to forward POST requests to **http://127.0.0.1:5182/webhooks/commerce**.
Preserve the exact body bytes and the `openiap-signature`,
`openiap-timestamp`, `openiap-event-id`, and `openiap-delivery-id` headers. The
receiver binds to loopback; the proxy provides public TLS. Forwarding the
public Host header is supported. `GET /health` checks local availability.

Use one emitter/project and signing key per receiver database. Agree on that
scope and opaque user IDs with the emitter before connecting. Keep the SQLite
file on persistent storage. The standalone example does not provision tenants,
rotate secrets, or replay events into a business-processing pipeline.

## Connect your existing processing code

`webhooks.mjs` exports the Fetch-compatible receiver used by this process.
`consumer.mjs` shows its configuration and lifecycle. Acknowledge only after
durable ingestion, then let your own worker process the inbox. Handle business
side effects idempotently too; inbox deduplication alone does not make your
external side effects exactly once.

Preserve missing values as unknown. A renewal can represent a charge, while
cancellation or an entitlement update is not automatically another purchase.
The inbox does not calculate MRR, attribution, tax, currency conversion, or
refund totals. Your product owns those rules and the additional data it needs.

If events drive access, respect the event's expiry boundary and refresh current
access from the account authority when needed. This example receiver only
stores events; it does not enforce an app's access policy.

[Back to the example](../README.md) · [Choose an integration role](../INTEGRATE.md)
