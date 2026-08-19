# gemini-local-bridge

`gemini-local` runs the official Gemini CLI 0.55.1 as the user-facing host while routing model inference to a local llama.cpp backend. The local model is never renamed or presented as Gemini: `clientModel` is Gemini-side protocol context, while `backendModel` is the real llama.cpp model identity.

The Phase C1-C3 implementation has now completed real Android/Termux acceptance, including real GGUF inference and automatic llama-server lifecycle management.

## Accepted refs

Historical and current accepted milestones:

- Phase B promoted vendor head: `e9c5ad7f382be3144daf71b7f477db1a183955da`
- C1 host: `accepted/gemini-local-c1-host-v1` -> `b3e2e7066853e1fa1e69279ef1793907772625af`
- C2 host: `accepted/gemini-local-c2-host-v1` -> `0034a7fe1d9cfc9e1492bcb595b03013b07a2374`
- C3 host real inference: `accepted/gemini-local-c3-host-v1` -> `92be279298457d47b501d54ffea39e7fc3d28ec9`
- C3 first device full-chain proof: `accepted/gemini-local-c3-device-proof-v1` -> `154c013e6581c233a87ed1a6e2ad74747c689f6b`
- C3 final device lifecycle executable/test head: `accepted/gemini-local-c3-device-lifecycle-v1` -> `a51e04d24091b2a17c27279ea14ca1f33025d686`

`main` and `product/gemini-local-v1` remain untouched by these acceptance refs.

## Current behavior

With a valid local protocol config, an ordinary command such as:

```sh
gemini-local "hello"
```

runs this chain:

```text
user
  -> official Gemini CLI 0.55.1
  -> gemini-local Gemini/GenAI compatibility adapter
  -> llama-server on literal 127.0.0.1
  -> actual local GGUF model
```

The launcher:

- never falls back to hosted Gemini;
- never modifies the real `gemini` executable or global `@google/gemini-cli` install;
- isolates the Gemini child from caller credentials and normal Gemini workspace/IDE settings;
- keeps client and backend model identities distinct;
- rejects unsupported tool/function/media surfaces rather than silently faking them;
- uses bounded local-model timeouts suitable for mobile inference;
- reuses an already-healthy local backend;
- can lazily start an explicitly configured llama-server/model when the backend is down;
- verifies SHA-256 for the configured llama-server binary and GGUF before auto-executing them;
- can report live backend status and safely stop/restart only a process whose ownership is verified.

There is no Android-boot daemon. Automatic startup is lazy: the first prompt starts the managed backend if necessary; later prompts reuse it.

## Commands

```text
gemini-local doctor [--json]   filesystem/integrity/config diagnostics only
gemini-local status [--json]   diagnostics plus live backend/ownership status
gemini-local stop              stop only a verified gemini-local-owned backend
gemini-local restart           restart the configured managed backend
gemini-local version
gemini-local help
gemini-local <plain prompt>
```

`doctor` remains filesystem-only and does not probe the network or spawn the model. `status` performs the live loopback health/ownership check.

Interactive mode, slash commands, arbitrary caller-supplied Gemini CLI flags, and tool execution are still deferred.

## Configuration

### Protocol / identity config

`~/.config/gemini-local-bridge/llama-cpp-adapter.json`

Exactly six closed-world keys:

```json
{
  "schemaVersion": 1,
  "backend": "llama.cpp",
  "backendOrigin": "http://127.0.0.1:8090",
  "backendModel": "qwen-test-backend",
  "clientModel": "local-test-client",
  "geminiRoot": "/absolute/path/to/@google/gemini-cli"
}
```

`backendOrigin` must be literal HTTP loopback with an explicit port. `geminiRoot` must resolve to the verified pinned `@google/gemini-cli` 0.55.1 distribution.

### Optional managed-backend launch config

`~/.config/gemini-local-bridge/llama-cpp-launch.json`

```json
{
  "schemaVersion": 1,
  "serverPath": "/absolute/path/to/llama-server",
  "serverSha256": "<64 lowercase/uppercase hex characters>",
  "modelPath": "/absolute/path/to/model.gguf",
  "modelSha256": "<64 lowercase/uppercase hex characters>"
}
```

This file authorizes `gemini-local` to start only those exact local artifacts when the configured backend is not healthy. It does not authorize downloads, builds, package installs, or external hosts.

Managed runtime state and logs live under:

```text
~/.local/share/gemini-local-bridge/runtime/
```

## Integrity and security boundaries

The installer writes only below:

```text
~/.local/bin/gemini-local
~/.local/share/gemini-local-bridge/
~/.config/gemini-local-bridge/
```

It does not write into Termux `$PREFIX`, the real Gemini package, or an existing Ollama installation.

`vendor/phase-b/*` is the immutable ten-file promoted Phase-B payload. `PROVENANCE.json` records the expected Git blob SHA, SHA-256, mode and size. `gemini-local doctor` verifies that payload on every run.

The local adapter binds only to `127.0.0.1`. Backend origin validation rejects external hosts, `localhost`, IPv6, HTTPS, paths, queries and `0.0.0.0`. Outbound backend headers are a fixed allowlist; Gemini API keys, Authorization headers, cookies, telemetry/install headers and arbitrary caller headers are not forwarded.

Managed-backend child startup uses `shell:false`, a launcher-owned argv, `--host 127.0.0.1`, `--no-webui`, `--offline`, and a stripped environment. Before destructive stop/restart signals, Linux/Android ownership verification checks the recorded PID/start time plus `/proc/<pid>/exe` and command line against the configured llama-server/model/backend identity. If ownership cannot be proven, signaling fails closed.

## Real Termux acceptance

Final executable/test acceptance head:

```text
a51e04d24091b2a17c27279ea14ca1f33025d686
```

Device environment:

- Android 15, aarch64
- Node v26.4.0
- npm 11.19.0
- Git 2.55.0
- clang 21.1.8
- CMake 4.4.2
- normal Gemini 0.55.1 at Termux `$PREFIX/bin/gemini`
- pre-existing Ollama preserved

Pinned llama.cpp source:

```text
0021a77de0a8966059dc94548fb3b96654e0bb12
```

On-device llama-server:

```text
version: 0.1.1-dev (build 10479, commit 0021a77de)
SHA-256: 94f9aa667e042be00f8270cc8ae384db0dcf1587b9cac45cc22ce8c85704d594
```

Smoke-test model:

```text
Qwen/Qwen2.5-0.5B-Instruct-GGUF
qwen2.5-0.5b-instruct-q4_k_m.gguf
491400032 bytes
SHA-256: 74a4da8c9fdbcd15bd1f6d01d621410d31c6fc00986f5eb687824e7b93d7a9db
```

The 0.5B Qwen file is only a plumbing/smoke model. It is not the intended long-term model selection.

Accepted device evidence includes:

- pinned llama.cpp built successfully on Android/aarch64;
- direct `/health`, chat-completions, token-count and streaming behavior against the real GGUF;
- full real Gemini CLI -> adapter -> llama-server -> GGUF response on the phone;
- device-found caller IDE-settings preflight defect corrected with an internal isolated preflight context;
- device-found 30-second hosted-style timeout corrected with bounded mobile-local inference budgets;
- automatic backend startup from a stopped state returned `FINAL_LOCAL_AUTOSTART_OK`, exit 0;
- backend status after auto-start: `managed-running`, healthy, managed;
- Android-specific `process.platform === "android"` ownership verification defect corrected;
- ownership then reported `Owned process verified: yes`;
- final restart produced a new managed backend PID;
- subsequent ordinary prompt returned `FINAL_LOCAL_REUSE_OK`, exit 0;
- managed PID remained unchanged before/after that reuse prompt;
- final status remained `managed-running`, healthy, managed, ownership verified;
- normal Gemini remained version 0.55.1 throughout.

Current-head test evidence immediately before final Android-only ownership correction:

```text
focused device-finalization: 6/6
full default suite: 159 pass, 0 fail, 1 skipped
real pinned Gemini suite: 160/160, 0 skipped
.mjs syntax: 33/33
installer bash -n: pass
uninstaller bash -n: pass
Phase-B/provenance diff: empty
```

The final Android ownership correction changed only `lib/managed-backend.mjs` plus its focused device regression. That corrected head then passed the focused regression/syntax/install/status/ownership gate on the real device and the full lifecycle behavior above.

## Historical skeleton acceptance

The earlier skeleton/install-only Termux milestone remains preserved at:

```text
a1b59aea2b70a5699956b4fe66b435d4a8c320a0
```

That milestone proved install/reinstall/uninstall/purge, immutable Phase-B provenance, fail-closed no-backend behavior and preservation of normal Gemini before any local-inference code was wired in. It should not be confused with the later C3 inference/lifecycle acceptance.

## Deferred scope

Not claimed by the current acceptance:

- interactive Gemini CLI sessions;
- slash-command support;
- Gemini tool/function execution through the local model;
- embeddings/model-routing UX;
- automatic model download or package installation;
- Android-boot persistence;
- behavior on devices/architectures not represented by the tested Android 15/aarch64 Termux device;
- final long-term model choice.

See [`docs/TERMUX.md`](docs/TERMUX.md) for the reproducible device procedure and exact acceptance evidence.
