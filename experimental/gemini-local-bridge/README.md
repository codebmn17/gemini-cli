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
preservation of the existing Gemini CLI. Later commits only reconcile this
README and `docs/TERMUX.md`; they do not change executable/test/vendor content.

This acceptance does **not** validate future llama.cpp model inference or
future adapter/process-launch behavior that is not wired into this skeleton
yet.

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
                                 doctor, fail-closed run path, CLI dispatch,
                                 and — as of Phase C1 — the Gemini<->llama.cpp
                                 protocol-adapter core; see the Phase C1
                                 section below. Not wired into the CLI yet.)
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

The exact device-tested executable/test tree at
`a1b59aea2b70a5699956b4fe66b435d4a8c320a0` passed **56/56** tests on real
Android/Termux, with 0 failures/cancellations/skips/todo. All 20 applicable
`.mjs` files passed `node --check`, and both installer/uninstaller scripts
passed `bash -n`. The suite covers path resolution, provenance/integrity
verification (clean, tampered, missing-file cases), `doctor` behavior,
fail-closed prompt handling, CLI dispatch, path-safety boundaries, non-root
Termux directory permissions, and full install/reinstall/uninstall/`--purge`
end-to-end behavior.

The Phase C1 work described below adds 38 further tests on top of that
56-test tree (94 total on this Linux host); **C1 has not been run on
Termux/a device** — see the Phase C1 section for exactly what is and is
not covered.

## Phase C1: local protocol-adapter core (host-only, not wired in)

Adds `lib/gemini-protocol.mjs`, `lib/llama-protocol.mjs`, and
`lib/llama-cpp-adapter.mjs`: a **protocol compatibility layer** between the
official Gemini CLI host and a llama.cpp-compatible local backend. This
slice does **not** install llama.cpp, does **not** download or select a
GGUF model, does **not** launch the real Gemini CLI, does **not** change
`run.mjs` (arbitrary prompts still fail closed — `gemini-local "hello"`
still refuses, exactly as before), and **has not been run on a Termux
device**. It was built and tested only on this Linux host, against a fake
loopback llama.cpp-compatible server.

### Architecture

```
User -> Official Gemini CLI 0.55.1 -> [Gemini/GenAI protocol] ->
  gemini-local compatibility adapter -> [OpenAI-compatible protocol] ->
  llama-server -> the actual local model (Qwen / Gemma / Llama / DeepSeek / etc.)
```

Gemini CLI is the interface/agent host. The local model is the real,
independent model actually doing the work. llama.cpp is the local
inference engine. The adapter's only job is **protocol translation** —
Google's GenAI request/response shape on one side, llama.cpp's
OpenAI-compatible shape on the other — because those two wire formats
differ, not because the local model needs to pretend to be Gemini.

### Model identity is never rebranded

The adapter is configured with a fixed **backend model identity** (e.g.
`local-test-model`) that is always what is actually sent to llama.cpp. The
Gemini-side request's model string (e.g. `gemini-2.5-pro`, resolvable
because pinned Gemini CLI 0.55.1's legacy `resolveModel()` fallback passes
an unrecognized model string through unchanged — see the C1 implementation
report) is preserved only as protocol context (`clientRequestedModel`) and
is **never** used to select or rename the backend model. Responses report
the real backend model identity in `modelVersion` — never a
Gemini-branded name — so nothing hides a mismatch between what Gemini
CLI's UI might display and what actually generated the response. Final
model-selection/UI resolution is explicitly deferred to a later slice.

### Supported / rejected surface (text-only)

Supported: `generateContent`, `streamGenerateContent`, `countTokens`,
plain text content parts, `systemInstruction`, and the generation
controls with a faithful llama.cpp equivalent (`temperature`, `topP`,
`topK`, `maxOutputTokens`, `stopSequences`, `seed`,
`presencePenalty`/`frequencyPenalty`).

Rejected — explicitly, with a clear error, never silently dropped or
faked: `embedContent` (llama.cpp embeddings require a separately
configured embedding-capable model/pooling mode not guaranteed by the
general local-chat path), tool/function declarations and calls, inline
media/file data, cached content, `candidateCount > 1`, and any
generation-config field without a faithful local equivalent (response
schema/MIME type, logprobs, modalities, speech/thinking/image config).

### Safety properties

Binds only to literal `127.0.0.1`; the configured backend origin must be
exactly `http://127.0.0.1:<port>` (no hostnames, no `0.0.0.0`, no IPv6, no
https, no path) or the adapter refuses to start. Outbound backend headers
are a fixed, closed allowlist built fresh for every request — Gemini-side
credentials (`x-goog-api-key`, `Authorization`, cookies, installation/
telemetry headers) and arbitrary custom headers are never forwarded.
Request bodies and backend calls are bounded and time-limited; a client
disconnect cancels the in-flight backend request. Any backend failure
(unavailable, timeout, malformed response, unmapped finish reason) fails
locally with a sanitized error — never a fallback to hosted Gemini or any
other external endpoint, since the adapter has no other network
destination it is capable of reaching.

### Testing

```sh
cd experimental/gemini-local-bridge
node --test test/llama-cpp-adapter.test.mjs
```

38 tests against a fake, loopback-only llama.cpp-compatible HTTP server —
no internet access, no real llama-server binary, no GGUF, no Gemini
credentials, no Termux required. See the C1 implementation report for the
exact pinned-SDK and llama.cpp-documentation derivation this was built
against.
