# Comparison after implementing

The new runtime was written in this run from the published contract. The older
example's runtime files were not copied into it. The earlier example was then
extracted and tested in a separate folder after commit e7bd417 existed; see
[its actual commands](reference-comparison.json).

The new tests independently exercise the same outcomes: no ownership from
verification, one owner, paid time after cancellation, signed delivery with
one durable inbox effect, expiration, restart, and erasure. This is not a
provider-swapping or wire-interoperability test between the two examples.

IAPKit source and related tests were read for comparison after implementation:

| Responsibility | New example                                                         | IAPKit reference                                                                                                                                                                                                                                                                         |
| -------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Access         | SQLite records; exclusive `now < expiresAt`                         | [`isEntitledAt`, bounded reads](https://github.com/hyodotdev/openiap/blob/main/packages/kit/convex/subscriptions/query.ts), [`query.test.ts`](https://github.com/hyodotdev/openiap/blob/main/packages/kit/convex/subscriptions/query.test.ts)                                            |
| Ownership      | Synchronous SQLite transaction; fixed fixture roles                 | [`bindUserAsServer`](https://github.com/hyodotdev/openiap/blob/main/packages/kit/convex/subscriptions/mutation.ts), project-scoped credentials and mutation tests                                                                                                                        |
| Delivery       | One local worker, fixed loopback receiver, bounded retries          | [`delivery.ts`](https://github.com/hyodotdev/openiap/blob/main/packages/kit/convex/commerce/delivery.ts), [`delivery.test.ts`](https://github.com/hyodotdev/openiap/blob/main/packages/kit/convex/commerce/delivery.test.ts); leases, destination validation, HTTPS delivery             |
| Erasure        | SQLite transaction plus separate receiver erasure; keyed tombstones | [`drainSubscriptionUserErasurePage`](https://github.com/hyodotdev/openiap/blob/main/packages/kit/convex/subscriptions/internal.ts), [`mutation.test.ts`](https://github.com/hyodotdev/openiap/blob/main/packages/kit/convex/subscriptions/mutation.test.ts); project-scoped batched jobs |

IAPKit was not started or retested for this fresh-build run. It has real store
adapters and deployment responsibilities that this fixture does not implement.
The installed specification remains the authority in both implementations.
