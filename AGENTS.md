# Example acceptance

Read `README.md` for the runnable scope, `INTEGRATE.md` for product boundaries,
and `BUILD.md` for the implementation milestones and completion checks.

Before finishing a change:

- Follow the running example as a first-time reader on desktop and mobile.
  Explain the result and the reader's next decision before implementation
  detail. Keep a short record of the tasks attempted and points of confusion.
- Compare the affected responsibility with the corresponding IAPKit handler
  and test linked from the [purchase guide](https://openiap.dev/commerce-protocol/getting-started).
  Report the actual differences; the installed protocol remains authoritative.
- Replay changed implementation instructions in a clean project, using only
  the documented inputs. Run the startup command, tests, and affected demos.
  Retain failed attempts and verify the repaired behavior independently.
- Identify the tested source revision, commands, results, and fixture scope.
  Do not infer real-store support, full profile conformance, or interoperability
  between providers from a local fixture run. Label an AI reader simulation as
  a simulation, not a human user study.

Do not manufacture successful output or weaken acceptance to hide a failure.
