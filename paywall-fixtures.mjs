export const PAYWALL_STORES = [
  {
    id: "apple",
    label: "Apple fixture",
    userId: "alice-apple",
    variant: "A",
    key: "apple:fixture.apple.premium",
    chain: "apple-demo-chain",
    receipt: { store: "apple", apple: { jws: "fixture.apple.premium" } },
    price: { currency: "USD", amountMicros: 4990000, provenance: "store" },
  },
  {
    id: "google",
    label: "Google fixture",
    userId: "alice-google",
    variant: "B",
    key: "google:analytics-google",
    chain: "google-demo-chain",
    receipt: { store: "google", google: { purchaseToken: "analytics-google" } },
  },
];
