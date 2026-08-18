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

`gemini-local` is a launcher that runs the official Gemini CLI as a host and
routes inference to a local backend (first target: llama.cpp on Termux)
instead of hosted Gemini.

- `gemini-local doctor` (alias `status`) runs filesystem/integrity checks
  only — no model inference, no network request.
- A prompt (`gemini-local "hello"`) launches the real chain **only** once a
  valid local config exists (see Phase C2, below) — until then, or if the
  config is missing/invalid, it **fails closed**: non-zero exit, clear
  message, and it never falls back to hosted Gemini, exactly as at the
  skeleton stage.
- Nothing here installs or configures llama.cpp itself, or downloads a GGUF
  model; a real backend at the configured `backendOrigin` remains the
  operator's own responsibility.

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

- Not a working local-inference backend yet. `gemini-local` does not
  install llama.cpp or select/download a GGUF model itself — it can drive
  the real pinned Gemini CLI through the protocol adapter to *some* already-
  running llama.cpp-compatible backend the operator points it at (Phase C2),
  but that backend's existence remains entirely outside this bundle's scope,
  and none of this has been exercised on Termux. See
  [`docs/TERMUX.md`](docs/TERMUX.md) for the exact device evidence and the
  remaining deferred scope.
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
  lib/                           gemini-local's own logic: paths, integrity,
                                 doctor, CLI dispatch, the Gemini<->llama.cpp
                                 protocol-adapter core (Phase C1), and the C2
                                 local config + real launch orchestration
                                 (local-config.mjs, local-gemini-runner.mjs);
                                 run.mjs launches the real chain only once a
                                 valid local config exists — see the Phase C1
                                 and Phase C2 sections below.
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

The original Phase C1 author head `8e99448a87b0caa56017bc95df13ba5057066551`
added 38 tests and passed **94/94** on its Linux host. Independent review then
found bounded C1 defects in real llama.cpp usage-chunk handling, listener
binding enforcement, streaming timeout coverage, backend response bounding,
and closed-world request/query parsing. Those fixes added 10 further
hardening regressions (`test/c1-hardening.test.mjs`), re-validated at the
accepted C1 head `b3e2e7066853e1fa1e69279ef1793907772625af`: **104/104**.
Phase C2 (below) adds real-launch capability behind a local config file and
its own dedicated tests; see that section for current totals. Neither C1 nor
C2 has been run on Termux/a device — Linux-host validation only.

## Phase C1: local protocol-adapter core (host-only, not wired in)

Adds `lib/gemini-protocol.mjs`, `lib/llama-protocol.mjs`, and
`lib/llama-cpp-adapter.mjs`: a **protocol compatibility layer** between the
official Gemini CLI host and a llama.cpp-compatible local backend. This
slice does **not** install llama.cpp, does **not** download or select a
GGUF model, and does **not** launch the real Gemini CLI — it is a
self-contained protocol translator, exercised only by its own test suite
against a fake loopback llama.cpp-compatible server and, from C1 itself, not
wired into `run.mjs` at all (that wiring is Phase C2, below). **Has not been
run on a Termux device** — Linux-host validation only.

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
Gemini-side request's model string is preserved only as protocol context
(`clientRequestedModel`) and is **never** used to select or rename the
backend model. Responses report the real backend model identity in
`modelVersion` — never a Gemini-branded name. Final model-selection/UI
resolution is explicitly deferred to a later slice.

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
media/file data, cached content, `candidateCount > 1`, unknown semantic
request/Part/generation fields, and any known generation-config field
without a faithful local equivalent (response schema/MIME type, logprobs,
modalities, speech/thinking/image config).

### Safety properties

The adapter's exported server enforces literal `127.0.0.1` binding even if
a caller omits the host and rejects an explicit non-loopback bind. The
configured backend origin must be exactly `http://127.0.0.1:<port>` (no
hostnames, no `0.0.0.0`, no IPv6, no https, no path) or construction fails.
Outbound backend headers are a fixed, closed allowlist built fresh for every
request — Gemini-side credentials (`x-goog-api-key`, `Authorization`, cookies,
installation/telemetry headers) and arbitrary custom headers are never
forwarded. Request bodies and non-stream backend responses are byte-bounded;
backend timeouts remain active through streaming body consumption; a client
disconnect cancels the in-flight backend request. Streaming accepts current
llama.cpp's terminal usage-only `choices: []` chunk without treating it as a
protocol failure. Any backend failure fails locally — never a fallback to
hosted Gemini or another external endpoint.

### Testing

Original author validation at `8e99448a87b0caa56017bc95df13ba5057066551`:

```sh
node --test test/llama-cpp-adapter.test.mjs   # 38/38
npm test                                      # 94/94 total
```

Independent hardening added `test/c1-hardening.test.mjs` (10 focused
regressions for real llama.cpp usage-chunk handling, listener binding
enforcement, streaming timeout coverage, backend response bounding, and
closed-world request/query parsing) and was re-validated at the accepted C1
head `b3e2e7066853e1fa1e69279ef1793907772625af`:

```sh
node --test test/llama-cpp-adapter.test.mjs   # 38/38
node --test test/c1-hardening.test.mjs        # 10/10
npm test                                      # 104/104 total
```

C1 was not run on a Termux/Android device; Linux-host validation only.

## Phase C2: the real host chain (config-gated, host-only)

Proves and implements the real chain: the official, pinned Gemini CLI
0.55.1, launched by `gemini-local` itself, talking through the C1 adapter to
a local llama.cpp-compatible backend. This is the first slice that can
launch the real Gemini CLI — but only once a local config file exists and
validates; without one, `gemini-local "hello"` still fails exactly as
before, with the same message and exit code.

Adds `lib/local-config.mjs` (schema/validation), `lib/local-gemini-runner.mjs`
(the launch orchestration), and `lib/loopback-origin.mjs` (the
loopback-origin format shared by the C1 adapter and the C2 config, extracted
out of `llama-cpp-adapter.mjs` so `lib/local-config.mjs` — and therefore
`doctor.mjs`, which reuses it — never needs that file's own `node:http`
listener code just to validate a string). Rewrites `lib/run.mjs` and extends
`lib/doctor.mjs`.

Still does **not**: install llama.cpp, download or select a GGUF model,
touch a Termux device, add tool execution, forward arbitrary caller argv to
the real Gemini CLI, or support interactive/slash-command mode. Still
**never** falls back to hosted Gemini on any failure.

### Local config

`~/.config/gemini-local-bridge/llama-cpp-adapter.json` (path unchanged from
the C1-era skeleton placeholder it promotes — see `lib/paths.mjs`) is the
single file that turns `gemini-local` from "always fails closed" into
"launches the real pinned Gemini CLI against a local backend". Exactly six
keys, closed-world (`lib/local-config.mjs`):

```json
{
  "schemaVersion": 1,
  "backend": "llama.cpp",
  "backendOrigin": "http://127.0.0.1:<port>",
  "backendModel": "<actual local model id, sent to the backend>",
  "clientModel": "local | local-<id> | local/<id> (sent to Gemini CLI)",
  "geminiRoot": "/path/to/a verified @google/gemini-cli 0.55.1 install"
}
```

Loading is a bounded, no-follow, regular-file-only read; `backendOrigin`
reuses the C1 loopback validator, `geminiRoot` reuses the accepted Phase-B
pinned-distribution verifier unmodified, and `clientModel` is checked
against a neutral-only pattern that also rejects any value ending in
`"flash"` — pinned Gemini CLI's own model resolution treats any such string
as flash-family and may rebrand it internally, so a `"local-flash"`-style
value is rejected even though it matches the neutral prefix. There is no
credential field in this schema, and the exact-key-set check rejects
anything else — there is nowhere to put one even by accident. A missing or
invalid config is reported by `doctor` as informational (expected /
recoverable), never as package corruption.

### What actually launches, and how

Once a valid config is loaded, `gemini-local <prompt text>` (`lib/run.mjs`)
runs the full chain (`lib/local-gemini-runner.mjs`): Phase-B preflight, a
bounded backend `/health` check (never launches Gemini against an unhealthy
backend), fresh re-verification of the pinned Gemini distribution, starting
the C1 adapter on an ephemeral `127.0.0.1` port, materializing an isolated
Phase-B runtime pointed at that adapter (reusing every accepted primitive —
`runPhaseBPreflight`, `resolvePinnedGeminiDistribution`,
`reverifyPinnedEntrypoint`, `buildLaunchContract`,
`verifyNoPinnedGeminiEnvSource`, `materializePhaseBRuntime`,
`verifyPhaseBRuntime`, `cleanupPhaseBRuntime` — in the same order the
accepted PR #6 routing probe uses them, none modified), spawning the real
pinned `gemini` entrypoint with a launcher-owned argv
(`--model <clientModel> --prompt <text> --output-format json`, never a
caller-supplied flag), and parsing its `JsonFormatter`-shaped JSON stdout.
Every path — success, timeout, crash, bad output — cleans up the adapter,
the child, and the isolated runtime directory.

The launch contract also forces `tools.core: []` in the isolated system
settings (on top of the accepted `tools.allowed: []`, which only bypasses
the confirmation dialog and does not by itself empty the tool registry) —
without it, pinned Gemini CLI registers its full built-in tool set
regardless, and would declare real tool/function capability to the model
that this build has no way to honor.

`gemini-local`'s own argv is intentionally narrow: any token starting with
`-`, or no tokens at all, fails closed (interactive mode and slash commands
are not supported yet) — `gemini-local` owns every argument the real Gemini
CLI process receives; nothing from the caller's argv is ever forwarded as a
separate argv entry.

### Two real-execution findings

Building this slice meant, for the first time, actually completing a
request/response round trip through the real pinned Gemini CLI — which
surfaced two real incompatibilities no synthetic C1 unit test could have:

1. **`tools`**: pinned `Client.startChat()`/`setTools()`
   (`packages/core/src/core/client.ts`) unconditionally sends
   `tools: [{ functionDeclarations: [...] }]` on every request, headless
   prompts included — there is no code path that omits it. C1's original
   check rejected the key's mere presence. `lib/gemini-protocol.mjs` now
   accepts only the exact harmless-empty shape (`functionDeclarations`
   absent or `[]`, no other key on any entry) that config's `tools.core: []`
   makes possible — a request offering any real function declaration, or
   any other `Tool` variant, still fails closed exactly as before.
2. **`generationConfig.thinkingConfig`**: any `clientModel` string pinned
   Gemini CLI doesn't recognize as a real Gemini model — which is every
   `clientModel` this bridge ever sends, by design — falls back to its
   `chat-base` model-config alias, which sets
   `thinkingConfig: { includeThoughts: true }` with no budget/level.
   `lib/gemini-protocol.mjs` now accepts only that exact default shape; a
   request with `thinkingBudget`, `thinkingLevel`, or any other key still
   fails closed exactly as before.

Both are narrow, evidence-derived relaxations of a presence check into a
content check, preserving the original "never silently drop a real
capability" invariant — not a loosening of what capability is actually
supported.

### Doctor

`gemini-local doctor` remains **filesystem-only** — loading the C2 config
(`loadLocalConfig`) is itself filesystem-only (a bounded read, `JSON.parse`,
and two equally filesystem-only checks), so doctor calling it does not
compromise that invariant; doctor's own source still never imports a
network/process-spawn primitive directly, or reaches around
`local-config.mjs` to import the pinned-distribution verifier itself (both
are enforced by static regression guards in `test/cli.test.mjs`). Doctor
reports whether a local config is present and valid (`local.configured`,
`local.host`, `local.backend`, `local.backendOrigin`, `local.clientModel`,
`local.backendModel`) but **never** whether the backend is actually
reachable — `local.backendHealth` is always the fixed string
`"not probed by doctor"`, and `hostedFallback` is always `"disabled"`.
`localInferenceReady` changed meaning from C1 (marker-file presence only,
while every prompt still unconditionally failed closed regardless) to "a
schema-valid config exists and a real launch will be attempted" —
`schemaVersion` in doctor's report is bumped to `3` to signal this.

### Testing

Three dedicated files. `test/local-config.test.mjs` covers config schema
validation only (no spawn, no network — a fake, manifest-valid distribution
stand-in, never the real pinned build). `test/c2-local-run.test.mjs` covers
the runner's orchestration and `run.mjs`/`cli.mjs`'s dispatch against a fake
"Gemini CLI" stand-in process (spawned for real, but a tiny script rather
than the real ~150MB+ pinned build) that itself makes a real request through
the real C1 adapter to a fake backend — proving health-check gating,
clientModel/backendModel separation, credential non-forwarding, cleanup on
every path (success, timeout, crash, bad output), and no-hosted-fallback —
plus exactly one test that is not mocked at all. `test/c2-review-hardening.test.mjs`
covers the independent-review findings below.

That one non-mocked test — the real pinned Gemini CLI 0.55.1 completing a
prompt through the real C1 adapter to a fake backend — is gated behind the
`GEMINI_LOCAL_TEST_PINNED_GEMINI_ROOT` environment variable, since the real
build is a large, freshly-built artifact this repository cannot commit and
a generic CI checkout will not have on disk. Without that variable set it
SKIPS itself with a clear reason rather than silently passing; **it was run
for real, at both heads below**, pointed at a verified checkout+build of
commit `41327e407da58aa01c409ef6685b7b5d379f295e` (`package.json` version
`0.55.1`).

Initial author head `3269934697d6f0e4d2ed1f5b214709dcf6689476`:

```sh
node --test test/local-config.test.mjs     # 21/21
node --test test/c2-local-run.test.mjs     # 20/20 + 1 skipped by default
GEMINI_LOCAL_TEST_PINNED_GEMINI_ROOT=<real pinned checkout> \
  node --test test/c2-local-run.test.mjs   # 21/21 (real Gemini CLI test included)
npm test                                   # 146/146 + 1 skipped by default (147/147 with the variable set)
```

#### Independent C2 review and hardening

Independent review of that head found and fixed 4 bounded defects before C2
acceptance:

1. `local-config.mjs`'s config read documented a no-follow discipline it
   didn't actually enforce at the syscall level (`openSync(path, 'r')`
   follows a symlink raced in after `lstat`) — the post-open dev/ino check
   happened to still catch a symlink-swap in practice, but nothing stopped
   a raced-in FIFO from hanging the process open with no writer. Fixed with
   `O_NOFOLLOW | O_NONBLOCK` at open time.
2. `checkBackendHealth()` trusted its `backendOrigin` argument and buffered
   an unbounded response body via `res.json()`. It now validates literal
   loopback before ever calling `fetch`, bounds its timeout, and byte-bounds
   the response (64 KiB) before parsing.
3. `runLocalGeminiPrompt()` trusted its `config` argument beyond one weak
   shape check, so a caller bypassing `local-config.mjs` entirely could have
   turned the exported runner into an arbitrary-network or
   Gemini-model-rebranding path. It now re-checks schema/backend/model/origin
   invariants itself as a second boundary.
4. If SIGTERM and SIGKILL both failed to terminate the Gemini child, the
   runner silently returned rather than surfacing that. It now raises
   `CHILD_TERMINATION_FAILED`.

Plus a documentation-only fix: the built-in `gemini-local help` text still
described the pre-C2 skeleton ("FAILS CLOSED: no local backend installed
yet"); it now describes the config-gated real-launch path.

`test/c2-review-hardening.test.mjs` adds 7 focused regressions. Re-validated
at the accepted current head `0034a7fe1d9cfc9e1492bcb595b03013b07a2374`:

```sh
node --test test/llama-cpp-adapter.test.mjs      # 38/38
node --test test/c1-hardening.test.mjs           # 10/10
node --test test/local-config.test.mjs           # 21/21
node --test test/c2-local-run.test.mjs           # 20/20 + 1 skipped by default
node --test test/c2-review-hardening.test.mjs    # 7/7
npm test                                         # 153/153 + 1 skipped by default
GEMINI_LOCAL_TEST_PINNED_GEMINI_ROOT=<real pinned checkout> \
  node --test test/c2-local-run.test.mjs         # 21/21 (real Gemini CLI test included)
GEMINI_LOCAL_TEST_PINNED_GEMINI_ROOT=<real pinned checkout> npm test   # 154/154
```

`.mjs` syntax: 31/31. Installer/uninstaller `bash -n`: both pass.
`vendor/phase-b/` and `PROVENANCE.json`: git-confirmed byte-identical to the
`product/gemini-local-v1` base, unchanged by either C2 head.

C1's own 104 tests are unchanged and still pass; C2 does not weaken or
bypass any C1 request/response validation. Neither C1 nor C2 has been run
on a Termux/Android device — Linux-host validation only.

## Phase C3: real local-inference proof (Linux host only)

Proves the full chain with a **real** llama.cpp server and a **real** GGUF
model — no fake backend — while making **zero changes to C1/C2 code**:
existing `lib/gemini-protocol.mjs`, `lib/llama-protocol.mjs`,
`lib/llama-cpp-adapter.mjs`, `lib/local-config.mjs`, and
`lib/local-gemini-runner.mjs` worked against the real pinned llama.cpp
server exactly as already accepted at C2. C3 is evidence and documentation
only in this repository; nothing under `experimental/gemini-local-bridge/`
changed.

```text
Official Gemini CLI 0.55.1 -> C1 adapter -> real llama-server -> real GGUF
```

### Pinned llama.cpp

Commit `0021a77de0a8966059dc94548fb3b96654e0bb12` of
[`ggml-org/llama.cpp`](https://github.com/ggml-org/llama.cpp) — the same
commit C2 already derived its `/health`/`/v1/chat/completions`/
`/v1/chat/completions/input_tokens`/streaming contract from. Independently
re-derived directly from that exact commit's own source (`tools/server/README.md`,
`tools/server/server-task.cpp`, and its own Python test suite) before
building: every C1/C2 protocol assumption held with **zero adapter code
changes required** — including the exact usage-only streaming chunk shape
(`choices: []` with `usage`) C1's own hardening pass had already handled.

Built CPU-only from that exact checkout (`cmake -B build -DCMAKE_BUILD_TYPE=Release`,
`cmake --build build --config Release --target llama-server`, GCC 13.3.0 /
CMake 3.28.3 on x86_64) into disposable scratch storage outside this
repository — no llama.cpp source, build artifact, or binary is committed
here. `llama-server --version` reported `version: 0.1.1-dev (build 10479,
commit 0021a77de)`.

### Smoke-test model

[`Qwen/Qwen2.5-0.5B-Instruct-GGUF`](https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF),
file `qwen2.5-0.5b-instruct-q4_k_m.gguf` (Q4_K_M, ~491.4 MB), published by
Qwen/Alibaba, Apache-2.0 licensed, qwen2 architecture. Chosen for this
smoke test specifically because it's officially published (not a
third-party requant), small enough for later phone deployment, and
text/chat-capable with no multimodal dependency — **not** a claim that this
is the intended permanent local coding model; model selection for real use
remains a separate, later decision. Downloaded to disposable scratch
storage only, never committed here.

Launched loopback-only, tools/UI/MCP disabled by leaving every relevant
flag at its documented default (`--tools`/`--agent` default to "no tools" —
neither was passed; no `--mcp-servers-config`/`--mcp-servers-json` was
supplied), an explicit neutral backend alias matching C2's `backendModel`,
and `--offline` once the GGUF was already local:

```sh
llama-server -m qwen2.5-0.5b-instruct-q4_k_m.gguf \
  --host 127.0.0.1 --port 8090 -a qwen-test-backend --no-webui --offline
```

### Real host proof

With that real server running, `lib/local-gemini-runner.mjs`'s
`runLocalGeminiPrompt()` ran, completely unmodified, against a C2 config
pointing `backendOrigin` at the real server: the real pinned Gemini CLI
launched, sent its request through the real C1 adapter, the adapter
forwarded to the real `llama-server`, and the real 0.5B model generated the
response `"C3_LOCAL_REAL_OK"` — the exact requested token, verbatim (not
required as the sole success criterion for a model this small, but it
happened). `backendModel` (`qwen-test-backend`) and `clientModel`
(`local-test-client`) were reported distinctly, matching C1/C2's identity
separation exactly as before.

A transparent, zero-transformation logging passthrough was placed in front
of the real server purely for request auditing (real GGUF inference still
happened entirely on the real `llama-server`; the passthrough only
recorded what arrived, unmodified, before forwarding byte-for-byte) — it
confirmed no `x-goog-api-key`/`Authorization` header ever reached the
backend, a canary value planted in place of a real `GEMINI_API_KEY` in the
parent environment never appeared anywhere the backend received, and the
request body's `model` field was always `qwen-test-backend`, never
`local-test-client`. After the run, no `gemini-local-phase-b-*` runtime
directory remained and no orphaned Gemini/adapter process remained running
— cleanup held exactly as in every C2 test.

### Testing

No C3-specific regression file was added — real execution against existing
C1/C2 code required no code change, so there was nothing new to add a
regression for. The full existing suite was rerun, unchanged, both before
and after the real host proof:

```sh
npm test                                                              153/153 + 1 skipped by default
GEMINI_LOCAL_TEST_PINNED_GEMINI_ROOT=<real pinned checkout> npm test   154/154
```

`.mjs` syntax: 31/31 (unchanged). Both installer/uninstaller scripts pass
`bash -n` (unchanged). `vendor/phase-b/` and `PROVENANCE.json`: untouched
(no repository file changed during C3 host work at all).

### Termux

**Not yet C3-device-accepted.** A read-only-first, package-authorization-gated
device-validation plan for the same known aarch64/Android/Termux target
already used for the skeleton acceptance is in
[`docs/TERMUX.md`](docs/TERMUX.md#c3-device-validation-plan-not-yet-executed).
It has not been executed. No package installation, model download, or
device mutation happens automatically — every such step is explicitly
gated behind separate user authorization at execution time, and the plan
preserves the device's existing `gemini`, existing Ollama, existing user
data, and `$PREFIX` outside that explicitly authorized scope. There is no
automatic model download and no automatic package installation anywhere in
this repository or its scripts.
