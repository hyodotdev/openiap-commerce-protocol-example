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
