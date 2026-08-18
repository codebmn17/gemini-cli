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

The current skeleton/install lifecycle has been validated on a real
Android/Termux device. The exact executable/test tree validated on-device was
`a1b59aea2b70a5699956b4fe66b435d4a8c320a0`. That validation covers the
installer, integrity/doctor behavior, fail-closed prompt handling, the full
56-test suite, default uninstall/config preservation, reinstall, purge, and
preservation of the existing Gemini CLI. It does **not** validate future
llama.cpp model inference or future adapter/process-launch behavior that is
not wired into this skeleton yet.

## What this is not

- Not a working local-inference backend yet. Real llama.cpp adapter/model
  inference remains deferred even though the current skeleton/install
  lifecycle is Termux-validated. See [`docs/TERMUX.md`](docs/TERMUX.md) for
  the exact device evidence and the remaining deferred scope.
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
  test/                          node:test suite (56 tests at device acceptance)
  docs/TERMUX.md                 reproducible Termux procedure + accepted/deferred scope
```

## Quick start

```sh
cd experimental/gemini-local-bridge
bash install-gemini-local.sh
export PATH="$HOME/.local/bin:$PATH"   # only for this shell; installer does not edit rc files
gemini-local doctor
```

For the exact Termux validation procedure and evidence, see
[`docs/TERMUX.md`](docs/TERMUX.md).

## Integrity

`gemini-local doctor` recomputes SHA-256 for every vendored file against
`PROVENANCE.json` on every run. The installer applies each promoted file's
manifest-declared installed mode (`0555` for promoted executable launchers,
`0444` for promoted libraries/package metadata) while keeping containing
vendor directories owner-writable so normal non-root reinstall/uninstall
works on Termux. A reinstall (`bash install-gemini-local.sh` again) replaces
the payload with a fresh copy from this bundle, so tampering or corruption
is both detectable (`doctor`) and recoverable (reinstall).

## Testing

```sh
cd experimental/gemini-local-bridge
npm test
```

The exact device-tested tree at
`a1b59aea2b70a5699956b4fe66b435d4a8c320a0` passed **56/56** tests on real
Android/Termux, with 0 failures/cancellations/skips/todo. All 20 applicable
`.mjs` files passed `node --check`, and both installer/uninstaller scripts
passed `bash -n`. The suite covers path resolution, provenance/integrity
verification (clean, tampered, missing-file cases), `doctor` behavior,
fail-closed prompt handling, CLI dispatch, path-safety boundaries, non-root
Termux directory permissions, and full install/reinstall/uninstall/`--purge`
end-to-end behavior.
