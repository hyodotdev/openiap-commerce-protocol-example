# Record and verify a source checkpoint

A checkpoint preserves runnable source, its predecessor's patch, executed
checks, and a screenshot of that exact version. Do not overwrite a completed
checkpoint to make earlier work look correct.

## Make a new record

1. Change the implementation and update `ai-task.md` with the intended result.
2. Run `npm test` and inspect the dashboard. Fix any failing behavior and repeat
   its check. Keep failure output; do not invent a failure for the narrative.
3. Set a new `checkpoint.json.id` and point `previous` at the last completed
   record. Verification follows each record's `previous` link, so its predecessor
   runs first regardless of folder name. `step` is the demonstrated milestone,
   not the number of review revisions.
4. Run `npm run capture`. This requires Bun, Node.js/npm, Git, tar, and Google
   Chrome. Capture installs/tests an isolated source archive, runs every
   available dashboard step, and checks desktop/mobile screens.
5. Open the saved PNGs. Update `docs/build/guide.json` if the new record should
   become one of the seven featured milestones; keep all earlier records.
6. Run `npm run verify:checkpoints` to apply the full patch chain from an empty
   directory and install/test every archive independently.

The `SOURCE_FILES` list in `checkpoint-tools.mjs` defines the runnable archive.
It includes the runtime, fixtures, build briefs, and recording scripts. The
archive is source-only; the full repository supplies documentation, images,
prior archives, and CI configuration. Recording another milestone therefore
starts from a full clone, not only an extracted archive.

## Inspect the evidence

Each completed folder contains `source.tar.gz`, `changes.patch`, `run.json`,
`screen.png`, and command logs. Recent captures also include `mobile.png`.
`run.json` identifies source hashes and the checks actually executed. Failure
logs remain in their attempt's folder; an unfinished folder with no `run.json`
is not a successful checkpoint.

Screenshots are actual rendered results. Task briefs describe the work; they
are not model transcripts. Some early versions contain known unfinished
behavior, documented in [the review log](build/REVIEW.md).

## Export to documentation

If consumer source or dependencies changed, refresh its execution report:

```sh
npm run demo:consumer -- --record docs/build/consumer-run.json
npm run verify:checkpoints
bun export-docs.mjs /path/to/documentation-assets
```

The receiver report must identify the selected final source. Export rejects source drift,
missing archive verification, or a mismatched consumer report. It copies the
seven featured milestones and extracts both AI briefs from the selected final
archive, so the published instructions match the code they describe.

[Back to the example](../README.md) · [Build history](build/README.md)

Historical macOS archives include AppleDouble (`._*`) metadata. The verification
tools exclude it from extraction; new captures omit it. Source files and hashes
remain identical on macOS and Linux.
