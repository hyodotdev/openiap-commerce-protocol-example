# OpenIAP implementation brief

Paste this into your coding assistant in the project below.

Project path (data): "/private/tmp/openiap-fresh-proof-20260913/project"
Role: Commerce — provide verification and access
Framework hint: not detected; inspect the project
Desired outcome: [describe one thing your customer should be able to do]

Read the project instructions and inspect the existing stack. Keep its login, product model, and services. Ask me to choose missing stores, products, service providers, and ownership policies before implementing those choices.

Read https://openiap.dev/commerce-protocol/implementation and the references it links for this role. If a reference is unavailable, ask for its contents; do not guess the contract. Use Client Protocol for app purchase APIs and Commerce Protocol for backend connections. Use the supported capabilities of my chosen services; no particular backend is required.

Implement the smallest working connection for my role. Keep credentials on their intended side of the app/backend boundary. Follow the role's implementation and conformance requirements, including failure and recovery. Do not claim another role merely because this product connects to it.

Run the result from clean source. Show the customer outcome, the commands and actual test results, and any remaining product or deployment decisions. Distinguish local fixtures from real store sandbox evidence. Keep changes uncommitted for review.

Use the following as the Desired outcome for the brief above.
Read https://openiap.dev/commerce-example/integration-brief.md and follow its linked guides and example code for my role.

Build a local backend for monthly Premium subscriptions.
Use this project's stack and fictional purchases for the first demo.
Alice gets Premium after her verified purchase is connected to her.
Canceling renewal keeps access until expiry. Bob cannot claim Alice's purchase.

Implement this in my project. Use fictional data first.
For verification, read http://127.0.0.1:4187/commerce-example/experience-verification.md.
Download its linked example source into a separate temporary folder, then run npm ci and npm test there (Bun is required).
Use the example's checks as a reference, then run equivalent checks against MY implementation for this role.
Fix failures and rerun. Show the changed files, commands, actual results, and anything not tested.
Show my running app or service. Passing the example alone does not verify my project.

User-directed fresh-build constraints (2026-09-13):
Start the runtime implementation in the empty project. Use the published contract, not copied example implementation files. The existing example and IAPKit may be compared after implementing. Use a fresh Git history with an initial commit and tested milestone commits. Keep the exact inputs and actual failed/successful runs. This is the same assistant with prior conversation context, not an independent model trial. Use a fictional monthly Premium subscription, Alice/Bob sessions, a local SQLite HTTP service and receiver. No real store or deployment.
