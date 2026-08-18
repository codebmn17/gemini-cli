# gemini-local-bridge (promotion bundle, skeleton stage)

Self-contained install bundle for `gemini-local`, promoted from the
independently-reviewed and accepted Phase B "Termux local-model bridge"
review stack (`codebmn17/gemini-cli`, PR #2–#6), specifically from accepted
head [`e9c5ad7f382be3144daf71b7f477db1a183955da`](https://github.com/codebmn17/gemini-cli/commit/e9c5ad7f382be3144daf71b7f477db1a183955da).

This directory is **not** a continuation of the PR #2–#6 review stack and
does not build on top of those review branches — it is fresh work on top of
`main`, containing byte-for-byte copies of the accepted Phase B artifacts
plus new `gemini-local` product code. The old review staircase (PR #2–#6)
remains untouched and unmerged.

## What this is

`gemini-local` is meant to become a launcher that runs the official Gemini
CLI as a host and routes inference to a local backend (first target:
llama.cpp on Termux) instead of hosted Gemini. **This bundle does not do
that yet.** At this skeleton stage:

- `gemini-local doctor` (alias `status`) runs filesystem/integrity checks
  only — no model inference, no network request.
- Any other invocation, including an arbitrary prompt, **fails closed**:
  non-zero exit, clear message, and it never falls back to hosted Gemini.
- The llama.cpp adapter is not installed or wired up in this slice, so
  `doctor` is expected to report `NOT READY`.

## What this is not

- Not a Termux build or Termux validation. Everything in this bundle was
  built and tested on a Linux host. See [`docs/TERMUX.md`](docs/TERMUX.md)
  for the exact commands to run on-device, and its explicit list of what
  remains unverified until someone does.
- Not a modification to the real `gemini` executable or the globally
  installed `@google/gemini-cli` npm package. The installer only ever
  writes to `~/.local/bin/gemini-local`,
  `~/.local/share/gemini-local-bridge/`, and
  `~/.config/gemini-local-bridge/`.
- Not a merge of the PR #2–#6 review stack, and not a change to `main`.

## Layout

```
gemini-local-bridge/
  bin/gemini-local              installed launcher shim (CommonJS; dynamically
                                 imports lib/cli.mjs so it runs correctly with
                                 no file extension via its shebang)
  lib/                           gemini-local's own logic (paths, integrity,
                                 doctor, fail-closed run path, CLI dispatch)
  vendor/phase-b/                immutable, byte-for-byte promoted copies of
                                 the accepted Phase B lib/bin files + package.json
                                 (test/ files are intentionally excluded — dev/CI
                                 only, not needed at runtime)
  PROVENANCE.json                SHA-256 + git-blob-SHA manifest for every
                                 vendored file, anchored to the promoted commit
  tools/generate-provenance.mjs  regenerates PROVENANCE.json from vendor/ on disk
  install-gemini-local.sh
  uninstall-gemini-local.sh
  test/                          node:test suite (55 tests, run on this Linux host)
  docs/TERMUX.md                 exact copy-paste Termux commands + NOT-TESTED list
```

## Quick start (Linux host)

```sh
cd experimental/gemini-local-bridge
bash install-gemini-local.sh
export PATH="$HOME/.local/bin:$PATH"   # only for this shell; installer does not edit rc files
gemini-local doctor
```

For Termux, see [`docs/TERMUX.md`](docs/TERMUX.md).

## Integrity

`gemini-local doctor` recomputes SHA-256 for every vendored file against
`PROVENANCE.json` on every run. The installer also marks the vendored
payload read-only (`0444`) after copying it in. A reinstall
(`bash install-gemini-local.sh` again) always replaces the payload with a
fresh copy from this bundle, so tampering or corruption is both detectable
(`doctor`) and recoverable (reinstall).

## Testing

```sh
cd experimental/gemini-local-bridge
npm test
```

55/55 tests passing on this Linux host as of the final host-validation run, covering:
path resolution, provenance/integrity verification (clean, tampered,
missing-file cases), `doctor` behavior (including proof it never calls
`fetch`, plus a static source check that it never imports
`node:child_process`/`node:net`/`node:http(s)`), fail-closed prompt
handling, CLI dispatch, and full install/reinstall/uninstall/`--purge`
end-to-end behavior including PATH and read-only-permission checks.
