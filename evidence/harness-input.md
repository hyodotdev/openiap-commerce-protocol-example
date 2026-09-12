# Iterative harness follow-up

The maintainer requested a continuing review and execution loop until the AI
instructions and example demonstrate the intended integration. The example is
the executable verification reference. Public material must remain generic.

Starting source: `4d458ea` on `codex/commerce-protocol-from-scratch`.
The same AI continued with the existing conversation and code context. This is
not a fresh independent-agent build or a one-prompt benchmark.

Review found an expiry-boundary renewal missing its new entitlement grant,
provider responses used without schema validation, and no reproducible command
covering CLI output plus the actual process-restart flow. The provider comparison
also needed the current paywall handler and an explicit policy for events that
omit purchase-chain references.

The follow-up adds those checks, fails closed on malformed responses, and uses
IAPKit's existing local harness for a second provider. The store responses,
identity and money remain fixtures. The updated documentation separates the
seven-step backend source, the paywall connection source and older bridge files.

Independent review then reproduced a trailing-slash provider URL bypass and
found that replay checks did not assert acknowledgement status. Normalize request
URLs, validate the known protocol operation, test both base URL forms, and record
successful replay acknowledgements before claiming deduplication.
