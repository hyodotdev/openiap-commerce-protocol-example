# Reproduce the verified connection

Executed source: [8ad87ff](https://github.com/hyodotdev/openiap-commerce-protocol-example/tree/8ad87ffaa55aab1e2585285fe2ca320441e31209).
This record was committed afterward; it does not change the tested implementation.

| Check | Recorded result | Repeat it |
| --- | --- | --- |
| CLI output, behavioral suite, HTTP flow and process restart | [19 tests, 236 assertions, 51 REST cases and 8 harness checks](./harness-verification.json) | Check out the source above, run `npm ci`, then `npm run verify`. |
| Same paywall and event consumer against local IAPKit | [19 connection checks, 170 existing regressions and acknowledged replays](./provider-verification.json) | Follow the [pinned sources and commands](./paywall-provider-reproduction.md). |
| Purchase, delivery, renewal, cancellation and redelivery in the browser | [Actual browser observations](./harness-browser.json) | Run `PORT=5198 npm start`, then open `/paywall` and follow the buttons in `PAYWALL.md`. |

The [implementation request](./harness-input.md) records the iterative AI work.
The [expiry regression](./renewal-boundary-failure.json) and
[provider URL regression](./provider-url-failure.json) retain failures reproduced
before their fixes. Store purchases, identity and prices are fixtures. Local
HTTP, persistence, signatures and the IAPKit handlers execute; real checkout and
an external product integration remain outside these results.
