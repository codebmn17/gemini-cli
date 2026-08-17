# Termux local-model bridge plan

This document defines a temporary, reviewable plan for running the existing
`Gemini CLI` host against local model backends without modifying or permanently
forking `Gemini CLI` source. The first target is the currently installed Termux
build, with later validation on macOS and Ubuntu.

<!-- prettier-ignore -->
> [!NOTE]
> This is a planning artifact on a temporary fork branch. It does not implement
> a local-model bridge, change `Gemini CLI`, alter authentication, or authorize a
> merge into `main` or upstream. The intended final result is installed locally,
> while the fork's `main` continues to track upstream.

## Status and authority

The plan is review-only. No runtime behavior changes in this commit.

- Repository: `codebmn17/gemini-cli`.
- Temporary plan branch: `plan/termux-local-model-bridge-v1`.
- Branch base: `9a15c45fbfc9f36a9817e0113dbd4fc1138840f0`.
- The fork is a direct fork of `google-gemini/gemini-cli`.
- The branch base matched the fork's `main` when this plan branch was created.
- This branch is not intended to merge into the fork's `main`.
- Any later implementation remains external to the installed `Gemini CLI`
  package and must preserve normal `gemini` behavior.

The source target and the branch base are intentionally different pins. The
phone currently runs stable `Gemini CLI` `0.55.1`, while the temporary review
branch follows the newer upstream-tracking fork state. Implementation must test
against the installed version first rather than assuming current `main` behaves
identically.

## Evidence baseline

The plan separates device observations from repository source evidence so later
reviews can tell what was actually observed from what was inferred.

### Device-observed environment

A bounded read-only investigation from the active Termux installation reported
these facts on August 17, 2026. They must be rechecked before implementation if
the device is updated.

- Executable: `/data/data/com.termux/files/usr/bin/gemini`.
- Package: `@google/gemini-cli`.
- Installed version: `0.55.1`.
- Global module root:
  `/data/data/com.termux/files/usr/lib/node_modules/@google/gemini-cli/`.
- Entry point: `bundle/gemini.js`.
- Platform: Android/Termux `aarch64`.
- Node.js: `26.4.0`.
- Python: `3.14.6`.
- User context file: `~/.gemini/GEMINI.md`.
- `llama.cpp` is already usable in Termux.
- The existing Ollama binary at `~/bin/ollama` does not execute natively in the
  current Termux environment.
- Ollama is usable in the user's macOS and Ubuntu environments.

The device investigation identified the installed package as the official
Google package rather than a Termux-specific fork. This repository plan does not
assume that every future device install has the same identity.

### Stable-source pin

Official release `v0.55.1` is pinned at commit
`41327e407da58aa01c409ef6685b7b5d379f295e`. Its root `package.json` declares
`@google/gemini-cli` version `0.55.1`, Node.js `>=20.0.0`, and
`bundle/gemini.js` as the `gemini` executable.

At `v0.55.1`, `packages/core/src/core/contentGenerator.ts` provides the source
contract that matters most to this plan:

- `getAuthTypeFromEnv()` selects `AuthType.GATEWAY` when `GOOGLE_GEMINI_BASE_URL`
  is set and takes precedence there over `GEMINI_API_KEY`-based selection.
- Inside the `GATEWAY` branch of `createContentGenerator()`, an empty API key is
  accepted: the gateway path constructs the normal `GoogleGenAI` client with a
  custom `baseUrl`, and when the gateway API key is empty the source explicitly
  adds an empty `x-goog-api-key` header rather than requiring a real Google
  credential. The `@google/genai@1.30.0` client (`GoogleGenAI` and `NodeAuth` in
  `dist/node/index.cjs`) does not throw on an empty API key at construction or
  header-attachment time.
- `ContentGenerator` exposes four model-facing operations:
  `generateContent()`, `generateContentStream()`, `countTokens()`, and
  `embedContent()`.

This confirms the `GATEWAY` branch itself is empty-key-safe, but it does not by
itself prove that a normal `gemini` invocation ever reaches that branch. A
separate, higher layer in `packages/cli` gates which `AuthType` value the
process actually uses, and that layer does not treat `GATEWAY` as a supported
auth method for a normal (non-`--acp`) invocation:

- `getAuthTypeFromEnv()` is called only from
  `packages/cli/src/validateNonInteractiveAuth.ts`, and only as a fallback:
  `configuredAuthType || getAuthTypeFromEnv()`, where `configuredAuthType` is
  `settings.merged.security.auth.selectedType`. If the device has any
  persisted auth method (the expected state for the target Termux device,
  which is already used daily), that persisted value wins and
  `GOOGLE_GEMINI_BASE_URL` is never used to select `GATEWAY`.
- Interactive startup (`packages/cli/src/gemini.tsx`,
  `packages/cli/src/ui/auth/useAuth.ts`) never calls `getAuthTypeFromEnv()` at
  all. It reads `settings.merged.security.auth.selectedType` directly, so
  environment variables cannot select an auth type for an interactive session
  by themselves.
- Even when `AuthType.GATEWAY` is reached (persisted `selectedType` unset, in
  non-interactive mode, with `GOOGLE_GEMINI_BASE_URL` set),
  `packages/cli/src/config/auth.ts`'s `validateAuthMethod()` has explicit
  branches only for `LOGIN_WITH_GOOGLE`, `COMPUTE_ADC`, `USE_GEMINI`, and
  `USE_VERTEX_AI`. Any other value, including `GATEWAY`, falls through to
  `return 'Invalid auth method selected.'`, and `gemini.tsx` treats that as a
  fatal authentication error. This validation call is skipped only when
  `settings.merged.security.auth.useExternal` is `true` — a persisted setting,
  not an environment variable.
- The only in-source call sites that construct and use `AuthType.GATEWAY`
  without going through `validateAuthMethod()` are
  `packages/cli/src/acp/acpSessionManager.ts` and `acpRpcDispatcher.ts`, which
  belong to the Agent Client Protocol (`gemini --acp`) surface, not the
  interactive REPL or the plain non-interactive `-p`/piped flow this plan's
  `gemini-local` wrapper targets.

Net effect: the `GATEWAY` empty-key behavior is real, but on a device with a
persisted auth method the ordinary `gemini` invocation requires the wrapper to
control both `security.auth.useExternal` and
`security.auth.selectedType: "gateway"` through a settings layer for both
interactive and non-interactive local-mode runs. In non-interactive mode the
persisted `configuredAuthType` otherwise wins before `getAuthTypeFromEnv()` is
consulted; in interactive mode the environment never selects the auth type at
all. `GOOGLE_GEMINI_BASE_URL` and `GEMINI_TELEMETRY_ENABLED` alone are therefore
insufficient for this target.

The `v0.55.1` configuration reference (`docs/reference/configuration.md`) also
documents `GOOGLE_GEMINI_BASE_URL` as a supported Gemini API base URL override
and allows plain HTTP for `localhost`, `127.0.0.1`, and `[::1]`, but the
reference text itself frames this override as applying "when using
`gemini-api-key` authentication" (`AuthType.USE_GEMINI`). It does not document
`GATEWAY` as a supported end-user auth method at all. This is corroborating
evidence that `USE_GEMINI` with a placeholder key, not `GATEWAY`, is the
documented, tested route to a custom `baseUrl` for a normal `gemini`
invocation — see the revised wrapper contract below.

`packages/cli/src/config/settings.ts` adds an independent settings-isolation
constraint. `GEMINI_CLI_SYSTEM_SETTINGS_PATH` replaces the native system
settings path. Unless `GEMINI_CLI_SYSTEM_DEFAULTS_PATH` is also explicitly set,
`getSystemDefaultsPath()` derives the system-defaults path from the directory of
that replacement. The merge order gives System Settings the highest file-based
precedence after schema defaults, system defaults, user settings, and workspace
settings. A bridge-owned system-settings file can therefore override the user's
saved auth selection, but it must never silently hide an existing native system
settings or system-defaults layer. Phase B must resolve those native paths and
record whether the files exist before any override is used.

### Upstream-tracking branch pin

The temporary plan branch starts at upstream-matching fork commit
`9a15c45fbfc9f36a9817e0113dbd4fc1138840f0`. Its root package currently reports
a `0.56.0` nightly development version.

This distinction is deliberate:

- Device acceptance begins against installed `0.55.1`.
- Source review also watches current upstream for contract changes.
- A later local install must record the exact `Gemini CLI` version it was tested
  against.
- A future `Gemini CLI` update requires a bounded compatibility recheck, not a
  permanent source fork.

## Goal

The goal is to preserve the mature `Gemini CLI` host while making model
inference replaceable through a local compatibility boundary.

The target operator experience is:

```text
normal hosted mode

  gemini
    -> unchanged official Gemini CLI
    -> unchanged Google authentication and model routing
    -> Google-hosted Gemini

local mode

  gemini-local
    -> the same installed official Gemini CLI executable
    -> process-scoped local settings and environment only
    -> localhost Gemini-protocol compatibility bridge
    -> selected local backend
       -> llama.cpp on Termux first
       -> Ollama on macOS/Ubuntu
       -> other explicitly supported local backends later
```

The local wrapper must not patch `bundle/gemini.js`, replace npm package files,
change the fork's `main`, or require maintaining a custom `Gemini CLI` build.

## Non-goals

This plan deliberately excludes several tempting expansions from version 1.

- Do not modify official `Gemini CLI` source to add another provider.
- Do not merge local bridge code into the fork's `main`.
- Do not represent local models as proprietary Gemini model weights.
- Do not promise feature parity before each feature is verified.
- Do not make Ollama a hard dependency for Termux.
- Do not fix the current Termux Ollama binary as part of this work.
- Do not implement Gemini Live or bidirectional WebSocket translation in the
  first bridge version.
- Do not change `Gemini CLI` approval mode, tool policies, sandbox settings, MCP
  permissions, or workspace trust rules.
- Do not silently send a local-mode request to Google when the bridge or local
  backend fails.
- Do not forward Google credentials to a local model server.
- Do not claim the whole CLI is offline merely because model inference is local.
  MCP servers, update checks, extensions, or user-configured tools can have their
  own network behavior.

## Architectural invariants

Every implementation and review pass must preserve these invariants.

1. `gemini` remains the untouched hosted path.
2. `gemini-local` changes configuration only for its child process.
3. The bridge binds to loopback by default and never exposes itself to the LAN.
4. The bridge selects its backend from trusted local configuration, never from a
   model request URL or prompt content.
5. Local mode never needs a real Google API key.
6. Local bridge logs redact credentials, prompt bodies by default, and sensitive
   headers.
7. A backend failure fails closed with a clear local error.
8. Unsupported protocol features fail explicitly rather than being silently
   dropped.
9. Tool execution remains owned by `Gemini CLI`; the bridge translates model
   tool requests but does not independently execute shell or workspace tools.
10. Existing `Gemini CLI` confirmations and approval policies remain in force.
11. The bridge never fabricates model reasoning or hidden chain-of-thought.
12. Model identity is presented truthfully to the operator.
13. The reviewed implementation SHA must match the locally installed artifacts.
14. Upstream compatibility is tested at version boundaries instead of preserved
    by carrying a long-lived source fork.
15. Local mode must not weaken or silently replace existing system settings,
    system defaults, approval policy, authentication policy, or security policy.

## Local installation layout

The final local installation must live outside the npm package and outside this
Git branch. Exact paths remain configurable, but this is the preferred layout:

```text
~/.local/bin/gemini-local
~/.local/share/gemini-local-bridge/
  bridge.mjs
  lib/
  tests/
~/.config/gemini-local-bridge/
  profiles.json
  local-mode-settings.json
```

We recommend using Node.js for the bridge because Node.js is already a
`Gemini CLI` requirement on all target machines and modern Node provides native
HTTP, `fetch`, streams, and abort signals. A Python implementation remains
acceptable only if review proves it materially reduces complexity without
adding brittle dependencies.

The installation must not modify `~/.gemini/GEMINI.md`. Launching the same
`gemini` executable naturally retains the user's existing global context,
skills, policies, settings layers, and workspace behavior. Local-mode-specific
overrides belong in process-scoped environment variables or a bridge-owned
settings file.

## Wrapper contract

`gemini-local` is a small launcher, not a second CLI. It must locate or use the
same `gemini` executable that normal hosted mode uses.

The wrapper must set only local-mode state before `exec`-ing `gemini`.

Expected inputs include:

- a bridge profile name,
- an optional local model/profile selection,
- normal `Gemini CLI` arguments passed through unchanged.

Environment variables alone are not sufficient. As detailed in the stable-source
pin evidence above, a normal (non-`--acp`) `gemini` invocation only reaches
`AuthType.GATEWAY` in the narrow case where no auth method is already persisted
in settings, the process is non-interactive, and
`security.auth.useExternal` is separately set to `true` in a settings layer
(`validateAuthMethod()` otherwise rejects `GATEWAY` outright, and interactive
mode never derives an auth type from the environment at all). The device
target already has a working, persisted `gemini` installation, so a persisted
`security.auth.selectedType` must be assumed present, not absent.

A bridge-owned `GEMINI_CLI_SYSTEM_SETTINGS_PATH` is permitted only after Phase B
resolves the native system-settings and system-defaults paths with both override
environment variables unset and records whether those files exist. If either
native file exists, local mode must fail closed before replacing the path until
a separately reviewed preservation/composition strategy proves that the native
settings and defaults remain effective. The wrapper must not weaken existing
approval, authentication, admin, workspace, or security policy merely to enable
local inference. Remote admin controls remain owned by `Gemini CLI`; this plan
does not claim the file-path override changes their behavior.

The first implementation must therefore test two candidate minimal
environments and record which one, if either, actually reaches the bridge for
both interactive and non-interactive invocation, rather than assuming the
simpler one works:

Candidate 1 (documented, `USE_GEMINI` route):

```text
GOOGLE_GEMINI_BASE_URL=http://127.0.0.1:<bridge-port>
GEMINI_TELEMETRY_ENABLED=0
GEMINI_API_KEY=<local-placeholder-value>
```

with a bridge-owned settings file (pointed to by
`GEMINI_CLI_SYSTEM_SETTINGS_PATH`, process-scoped) that sets
`security.auth.selectedType` to `gemini-api-key`. This is the auth type the
`v0.55.1` configuration reference documents `GOOGLE_GEMINI_BASE_URL` against,
it has an explicit, passing branch in `validateAuthMethod()`, and it reaches
the same `baseUrl`-override code in `contentGenerator.ts` that the `GATEWAY`
branch uses. The placeholder value is chosen by the wrapper, never a real
Google credential, and the bridge does not need to honor it as a real key; the
bridge can additionally check for this exact placeholder as a defense against
stray loopback traffic from other local processes.

Candidate 2 (`GATEWAY` route): the same process-scoped bridge-owned settings file
sets both `security.auth.useExternal: true` and
`security.auth.selectedType: "gateway"` for interactive and non-interactive
local-mode invocations, with no `GEMINI_API_KEY` set. Both settings are required
on the target device because an already-persisted selected auth type wins before
`getAuthTypeFromEnv()` in non-interactive mode and is read directly in
interactive mode. This matches the plan's original intent of never requiring a
placeholder credential, but depends on settings-layer behavior (`useExternal`
bypassing `validateAuthMethod()` and the higher-precedence system settings layer
overriding the persisted selected type) that must be device-verified before it
is trusted, since it is not covered by the project's own auth test suites for
the non-`--acp` invocation path.

Phase B must run both candidates against the installed `0.55.1` binary and
record which one actually reaches the loopback recorder, in both interactive
and non-interactive mode, before the wrapper contract is finalized.

For a stricter local posture, the same bridge-owned settings file referenced by
`GEMINI_CLI_SYSTEM_SETTINGS_PATH` can also disable update behavior or other
network-oriented features. That remains evidence-gated: we must first verify
the installed version respects the override without changing unrelated user
settings.

No wrapper variable may be exported into the caller's shell after `gemini-local`
exits.

## Local protocol boundary

The bridge must behave like the narrow Gemini REST surface that the installed
SDK actually calls. It must not pretend to implement every Google API.

The first device capture is expected to observe request paths equivalent to:

```text
POST /v1beta/models/<model>:generateContent
POST /v1beta/models/<model>:streamGenerateContent?alt=sse
```

The source contract also requires investigation of the paths used for:

```text
countTokens
embedContent
```

Do not freeze exact paths for those two operations until the localhost contract
probe records the installed `0.55.1` requests. The bridge router must support
the API version actually received rather than hard-coding `v1beta` throughout
its internal logic.

## Compatibility surface

Full local-agent usefulness requires more than translating chat text. The
adapter must treat each Gemini protocol feature as an explicit capability.

### Requests

The request translator must account for these fields when present:

- `systemInstruction`,
- `contents`,
- `parts`,
- user and model roles,
- text parts,
- `inlineData`,
- `fileData`,
- `tools`,
- `functionDeclarations`,
- `toolConfig`,
- `functionResponse`,
- `generationConfig`,
- structured response schema fields,
- stop conditions,
- model name,
- cancellation from the client connection.

Unknown consequential fields must not be discarded silently. The translator
must either preserve them, map them, or return a clear unsupported-capability
error.

### Responses

The response translator must account for these Gemini-facing concepts:

- `candidates`,
- candidate `content.parts`,
- text parts,
- `functionCall`,
- finish reasons,
- usage metadata when trustworthy counts exist,
- structured JSON output,
- streaming candidate chunks,
- explicit error objects.

The bridge must not invent usage counts, safety results, citations, grounding,
thought signatures, or reasoning metadata that the local backend did not
produce.

### Streaming

Streaming is a first-class compatibility requirement, not a cosmetic upgrade.
The bridge must translate backend stream events into valid Gemini SSE events
while preserving:

- incremental text,
- tool-call argument assembly,
- finish conditions,
- disconnect handling,
- backend cancellation,
- malformed-stream errors.

Chunk boundaries are transport details. The implementation must not assume one
backend chunk equals one Gemini candidate chunk.

### Tool declarations and calls

Tool calling determines whether local mode can act like an agent instead of a
chat wrapper.

The translator must support this direction:

```text
Gemini functionDeclarations
  -> local backend tool schema
  -> local model tool call
  -> Gemini functionCall
  -> Gemini CLI executes the approved tool
  -> Gemini functionResponse
  -> local backend tool-result message
```

The bridge must preserve function names, arguments, and call correlation. If the
backend uses tool-call IDs but Gemini content does not expose the same ID shape,
the bridge must maintain a bounded per-request correlation map.

Multiple tool calls in one model turn require an explicit test. Tool results may
arrive in later turns and must remain associated with the correct request
history.

Local model quality does not change `Gemini CLI` authority. A weaker model may
choose tools poorly, so the bridge must never bypass the CLI's confirmation or
policy layer to compensate.

### Structured output

Gemini structured-output requests can include response MIME type and schema
information. The bridge must map these requests only when the backend has a
compatible structured-output mechanism.

If a backend cannot honor the requested schema, the bridge must return an
explicit unsupported response rather than silently downgrading to free-form
text and pretending the contract was satisfied.

### Media and files

Multimodal support is capability-gated.

- `inlineData` can be translated only for a backend that accepts the matching
  media type.
- `fileData` can require retrieval semantics that are not automatically local.
- The bridge must not download remote file references without an explicit,
  reviewed policy.
- A text-only backend must reject unsupported media clearly.

Text and tool support can ship before multimodal support, but the UI and wrapper
must not advertise unsupported media as working.

### Token counting

`ContentGenerator.countTokens()` is part of the real `v0.55.1` source contract.
This matters because context management and compaction decisions can become
incorrect if the bridge invents token counts.

The backend abstraction therefore needs an explicit token-count operation.
Preferred sources are the active local model's own tokenizer or a backend-native
endpoint such as a llama.cpp tokenization route.

If exact counting is unavailable for a backend, the bridge must either disable
the dependent compatibility path with a clear error or mark an independently
reviewed approximation as approximate. It must never report guessed counts as
exact.

### Embeddings

`ContentGenerator.embedContent()` is also part of the source interface. Its
runtime importance must be measured before version 1 claims full compatibility.

The implementation must first record whether the normal interactive CLI path
calls embeddings in the workflows we care about. If it does, the bridge needs a
real embedding backend or a separately configured embedding model. If it does
not, embedding support can remain a documented deferred capability without
blocking the initial text-and-tools milestone.

## Backend abstraction

The bridge must be backend-neutral even though Termux has a preferred first
backend.

A conceptual internal interface is:

```text
Backend
  capabilities()
  generate(request, signal)
  stream(request, signal)
  countTokens(request)
  embed(request)
```

Each backend profile declares only capabilities it can actually satisfy.

### Termux first target: llama.cpp

Termux uses llama.cpp as the first local inference backend because it is already
known to work in the current environment.

The first target is a local llama.cpp server exposing an OpenAI-compatible chat
surface where practical, plus backend-native tokenization when needed. Exact
port, model, context size, chat template, and tool-call support must be captured
from the user's installed llama.cpp environment before implementation.

A local model is not automatically tool-capable just because the server accepts
an OpenAI-compatible request. Tool-call acceptance requires both server support
and a model/chat template that produces reliable structured calls.

### macOS and Ubuntu target: Ollama

Ollama is a second backend target because it already works in the user's macOS
and Ubuntu environments.

Prefer Ollama's OpenAI-compatible interface when it provides the semantics the
bridge needs. Use Ollama-native endpoints only when an essential capability is
missing from the compatible surface and the added adapter complexity is
justified.

The broken native Termux Ollama binary is not a bridge blocker and is not part of
this plan's repair scope.

### Future backends

A future backend can be added only through the bridge's backend contract. Do not
add one-off conditionals throughout Gemini request translation.

A new backend must declare and test:

- text generation,
- streaming,
- tools,
- structured output,
- media,
- token counting,
- embeddings,
- cancellation.

Unsupported capabilities remain explicit.

## Model identity and routing

The bridge must avoid presenting a local model as if it were a hosted Gemini
model.

`v0.55.1` model resolution allows unrecognized explicit model strings to pass
through in the default resolution path, but other CLI capability checks can
still depend on model families and aliases. Therefore model naming needs a
device test rather than an assumption.

The preferred truth hierarchy is:

1. Test whether an explicit local model identifier can pass through `Gemini CLI`
   without breaking routing or feature checks.
2. If that works, show the actual local model identity directly.
3. If it does not work, use a stable Gemini-facing compatibility model ID only
   inside the request path and make the wrapper print the actual local backend
   and model before launch.
4. Never silently label a local Qwen, Gemma, Llama, or other model as a real
   hosted Gemini model.

Backend selection belongs to a trusted local profile, not prompt text. Example
operator profiles can eventually include `termux-code`, `termux-fast`,
`mac-reason`, and `ubuntu-large`, but this plan assigns no specific model until
hardware and model tests are available.

## Security and privacy posture

A local adapter adds a new privileged process boundary. The design must remain
small enough to audit.

The bridge must:

- bind to `127.0.0.1` or an equivalent loopback address only,
- reject non-loopback listen configuration by default,
- load backend targets from trusted local configuration,
- reject arbitrary backend URLs supplied through model requests,
- set request body limits,
- validate content type,
- cap buffered streaming/tool argument state,
- redact authentication headers from logs,
- avoid logging prompt or tool payload bodies by default,
- propagate cancellation,
- close abandoned backend streams,
- use bounded request timeouts,
- return errors without stack traces or filesystem secrets to the model-facing
  client,
- never forward Google credentials to a backend.

Local mode must keep normal `Gemini CLI` tool confirmation behavior. The wrapper
must not set YOLO or another permissive approval mode automatically.

## Hosted-mode preservation

The project succeeds only if normal hosted use remains boring.

Acceptance requires proving that:

- `gemini` still launches the installed official package directly,
- no global base URL override is left in the shell environment,
- no npm package file is modified,
- no Google auth file is modified,
- no `~/.gemini/GEMINI.md` content is rewritten,
- existing native system settings and system defaults remain effective,
- deleting the local bridge files removes local mode without repairing
  `Gemini CLI` itself.

The bridge installation must therefore be reversible by deleting only its own
wrapper, configuration, and bridge directory.

## Local-network and telemetry truth

"Local inference" and "zero external network traffic" are separate claims.
Version 1 must use precise language.

`v0.55.1` exposes telemetry settings and the
`GEMINI_TELEMETRY_ENABLED` environment override. The local wrapper can disable
Gemini CLI telemetry for its child process without changing normal hosted mode.

Other features can still contact external services, including user-configured
MCP servers, extensions, update checks, or tools. Therefore strict offline mode
requires its own egress test before it is advertised.

The first deliverable can truthfully promise "no hosted-model API call for local
inference" once the localhost request-capture test and backend integration prove
that statement. It must not promise total offline operation until independently
verified.

## Failure behavior

Every failure mode must be designed before happy-path polish.

- Bridge not running: `gemini-local` reports the local startup failure and does
  not start hosted inference.
- Backend not running: bridge returns a local backend-unavailable error.
- Unsupported model capability: bridge returns an explicit unsupported error.
- Invalid Gemini request: bridge returns a bounded client error.
- Invalid backend response: bridge returns a bounded translation error.
- Stream disconnect: bridge aborts the backend request.
- Backend timeout: bridge cancels the request and reports timeout locally.
- Tool-call parse failure: bridge does not convert arbitrary text into a tool
  call.
- Structured-output failure: bridge does not claim schema conformance.
- Media on text-only model: bridge rejects the unsupported content.
- Missing token-count support: bridge does not invent exact token usage.
- Local profile missing: wrapper fails before launching `gemini`.
- Existing system settings/defaults would be shadowed: wrapper fails before
  launching local mode until a reviewed preservation strategy exists.

No local-mode failure may silently retry against a Google model endpoint.

## Implementation phases

Implementation is split into evidence gates so a broken high-level feature does
not obscure whether the underlying provider seam works.

### Phase A: accept the plan

Review this document against device evidence and the pinned `v0.55.1` source.

Completion proof:

- reviewers agree on the no-source-patch architecture,
- the installed-version pin is confirmed,
- the temporary Git workflow is accepted,
- no runtime code exists yet.

### Phase B: capture the installed localhost contract

Build the smallest disposable loopback recorder needed to observe requests from
installed `Gemini CLI` `0.55.1`. It must sanitize all captured data.

Before any settings-path override or auth candidate is attempted:

1. Resolve the native system-settings path with
   `GEMINI_CLI_SYSTEM_SETTINGS_PATH` unset.
2. Resolve the native system-defaults path with both
   `GEMINI_CLI_SYSTEM_SETTINGS_PATH` and
   `GEMINI_CLI_SYSTEM_DEFAULTS_PATH` unset.
3. Record whether either native file exists without modifying it.
4. If either file exists, stop the candidate probe and return to review until a
   preservation/composition strategy is accepted. Do not replace an existing
   system policy/settings layer for the sake of local mode.

Once that prerequisite is satisfied, test in this order:

1. Launch a recorder on `127.0.0.1`.
2. Run the documented `USE_GEMINI` candidate non-interactively with the
   bridge-owned settings layer forcing `selectedType: "gemini-api-key"`, a
   wrapper-owned placeholder `GEMINI_API_KEY`, and the base URL redirected to
   the recorder.
3. Separately run the `GATEWAY` candidate non-interactively with the bridge-owned
   settings layer forcing both `security.auth.useExternal: true` and
   `security.auth.selectedType: "gateway"`, no `GEMINI_API_KEY`, and the base URL
   redirected to the recorder. The probe must not inherit the persisted hosted
   auth type.
4. Repeat candidates 2 and 3 for an interactive session, since interactive
   startup has its own auth path and needs independent proof.
5. Issue a harmless prompt that reaches the recorder.
6. Record method, path, selected safe headers, and request shape.
7. Return a deliberate local error or static response.
8. Confirm no hosted model request was needed for the proof.
9. Repeat for streaming.
10. Trigger representative flows that reveal `countTokens` and embedding usage.
11. Record cancellation behavior.

This phase decides which auth candidate from the wrapper contract actually
reaches the installed bundle, in both interactive and non-interactive mode, and
whether an empty or placeholder key is required. Do not assume either
candidate works before this test records the result.

Completion proof:

- native system-settings and system-defaults paths and file-existence results are
  recorded,
- no existing native system policy/settings layer was silently replaced,
- the auth candidate that reaches the recorder is recorded for both interactive
  and non-interactive mode,
- exact request paths are recorded,
- actual auth/header behavior is recorded,
- normal `gemini` remains unchanged,
- no paid model inference was needed for the seam test.

### Phase C: static Gemini-compatible fake model

Implement a local server that speaks enough Gemini protocol to return fixed text
and fixed SSE streams without any model backend.

This isolates protocol correctness from inference behavior.

Completion proof:

- interactive text renders correctly,
- streaming text renders incrementally,
- intentional errors display correctly,
- client cancellation closes the server-side request,
- no local model is involved yet.

### Phase D: backend-neutral text bridge

Add the backend interface and connect the first Termux llama.cpp profile.

Completion proof:

- a user prompt reaches llama.cpp,
- the local response returns through normal `Gemini CLI` rendering,
- streaming works,
- model/backend identity is shown truthfully,
- backend failure cannot fall through to Google.

### Phase E: tool-call fidelity

Add function declaration, function call, and function response translation.

Completion proof must include at least:

- one tool declaration,
- one tool call,
- one approved tool result returned to the model,
- multiple tool declarations,
- multiple calls in one turn if the backend supports them,
- malformed tool output rejected safely,
- normal `Gemini CLI` confirmation behavior preserved.

This phase is the minimum bar for calling local mode an agent workflow rather
than a chat-only compatibility layer.

### Phase F: context and structured protocol support

Add the protocol features that affect long-running correctness.

Work includes:

- exact token counting for the active llama.cpp model,
- structured response handling,
- finish-reason mapping,
- trustworthy usage metadata where available,
- bounded error mapping,
- context-compaction regression checks.

Investigate embedding usage during this phase. Add a real embedding path only if
an accepted workflow needs it.

Completion proof:

- token counts come from a real tokenizer,
- structured-output tests pass or the capability is explicitly unavailable,
- no fabricated metadata is returned.

### Phase G: multimodal capability gate

Test media only after text, tools, and context behavior are stable.

Completion proof:

- supported image/media requests work with a selected multimodal backend, or
- local mode clearly reports that the active profile is text-only.

Remote file retrieval remains out of scope unless separately reviewed.

### Phase H: Ollama profiles on macOS and Ubuntu

Add Ollama only after the backend-neutral contract is stable with llama.cpp.

Completion proof:

- the same bridge translator works without Gemini-specific source changes,
- macOS Ollama profile passes text/stream tests,
- Ubuntu Ollama profile passes text/stream tests,
- tool support is advertised only for models that pass tool tests.

Termux Ollama remains optional and unrelated to bridge acceptance.

### Phase I: operational hardening

Harden startup, shutdown, logging, profile validation, and local egress posture.

Completion proof includes:

- loopback-only bind test,
- body-size test,
- timeout test,
- disconnect/abort test,
- backend-down test,
- no-secret-log test,
- no-Google-fallback test,
- wrapper environment-isolation test,
- hosted `gemini` regression check.

A separate network observation can determine whether the chosen local profile is
strictly offline beyond model inference.

### Phase J: reviewed local installation

Install only artifacts that match the accepted review SHA.

Before deleting the implementation branch, create and push a dedicated annotated
review tag that points exactly to the accepted implementation commit. Treat that
tag as immutable review evidence: never move or reuse it for a different commit.
The tag does not merge anything into `main` and is not a distribution claim.

The installation report must record:

- accepted implementation commit SHA,
- reviewed Git tag name,
- installed `Gemini CLI` version,
- bridge version or commit,
- backend profile,
- local paths,
- validation results,
- known unsupported capabilities.

After installation, run a fresh adversarial review and a final device smoke test.
Do not merge the temporary implementation into the fork's `main`.

## Test strategy

Tests must cover translation contracts independently from real models so model
nondeterminism cannot hide adapter bugs.

### Fixture tests

Keep sanitized fixtures for:

- basic text request,
- multi-turn text,
- system instruction,
- streaming text,
- one function declaration,
- multiple function declarations,
- one function call,
- multiple tool calls,
- function response,
- structured JSON request,
- inline image request,
- token count request,
- embedding request if observed,
- backend error,
- client abort.

Fixtures must contain no private prompts, credentials, or personal paths unless
the path is deliberately synthetic.

### Translator tests

Verify request and response conversion as pure data transformations whenever
possible. Network tests must focus on transport behavior rather than repeating
all conversion cases.

Important regressions include:

- role mapping,
- content-part ordering,
- JSON schema conversion,
- tool-call argument encoding,
- tool-result correlation,
- stream chunk fragmentation,
- finish reasons,
- usage metadata,
- malformed input,
- unsupported media,
- cancellation.

### Device tests

Device tests are evidence gates, not broad exploratory prompts.

Termux must prove:

- installed `0.55.1` gateway behavior,
- llama.cpp text generation,
- streaming,
- tool calling with a selected tool-capable model,
- token counting,
- hosted-mode preservation.

macOS and Ubuntu need only run the Ollama-specific subset after the common
translator is accepted.

## Capability reporting

The bridge must expose or print a compact capability summary for the active
profile so the operator can tell what is real before a session begins.

A profile can report states such as:

```text
text: supported
streaming: supported
tools: supported
structured-output: supported
media: unsupported
count-tokens: supported
embeddings: not-required
backend: llama.cpp
model: <actual-local-model>
```

Do not infer capability from a backend brand alone. A specific model and chat
template can change tool or media support.

## Proposed implementation artifacts

After plan acceptance, the temporary implementation branch can contain a small,
reviewable artifact set such as:

```text
experimental/termux-local-model-bridge/
  bridge.mjs
  lib/
    gemini-protocol.mjs
    backend-interface.mjs
    openai-compatible-backend.mjs
    llama-cpp-backend.mjs
    ollama-backend.mjs
  bin/
    gemini-local
  config/
    profiles.example.json
    local-mode-settings.example.json
  test/
    fixtures/
    *.test.mjs
  README.md
```

These paths are review artifacts only. The accepted files are copied to the
local installation paths after final review. They are not merged into the
upstream-tracking branch.

Keep the implementation dependency-light. Any external npm dependency requires
a concrete reason that Node's built-in HTTP, `fetch`, streams, URL, and abort
APIs cannot satisfy safely.

## Temporary Git review workflow

The fork is a review laboratory, not the permanent distribution channel for this
customization.

Use this sequence:

1. Keep `codebmn17/gemini-cli/main` tracking upstream.
2. Review this plan on `plan/termux-local-model-bridge-v1` through a draft PR to
   `main`.
3. After plan acceptance, branch
   `review/termux-local-model-bridge-v1` from the accepted plan commit.
4. Open the implementation PR against the plan branch, not `main`, so reviewers
   see only implementation changes relative to the accepted plan.
5. Run independent implementation and adversarial review passes.
6. Record the final accepted implementation SHA.
7. Create and push a dedicated annotated reviewed tag at that exact SHA and
   never move or reuse the tag.
8. Copy/install that exact reviewed artifact set locally.
9. Verify local file hashes or content against the accepted commit and tag.
10. Close the implementation PR unmerged.
11. Close the plan PR unmerged.
12. Delete both temporary branches after the local installation is verified.
13. Keep the reviewed tag and closed PRs as historical review evidence.

The reviewed tag is a durable Git-native anchor for reproduction after the
implementation branch is deleted. It records review identity only; it does not
merge the customization into `main` or turn the fork into the distribution
channel.

If upstream `main` changes during review, do not casually rebase and invalidate
review evidence. Reconcile only when the upstream change affects a bridge seam or
when the installed `Gemini CLI` version changes.

## Review roles

Use separate contexts for implementation and adversarial review.

The implementer must:

- follow this plan,
- source-verify protocol behavior,
- avoid expanding scope to provider modifications inside `Gemini CLI`,
- keep normal hosted mode unchanged.

The fresh reviewer must:

- assume the implementation can be wrong,
- reproduce the localhost contract independently,
- challenge tool-call and streaming edge cases,
- inspect secret handling and fallback behavior,
- verify unsupported capabilities fail explicitly,
- verify local installation artifacts match the reviewed SHA.

A second fresh pass must distrust fixes from the first review and repeat the
highest-risk tests.

## Acceptance criteria

Version 1 is accepted only when all required criteria below are proven.

Required for Termux:

- Normal `gemini` remains unchanged.
- `gemini-local` uses the same installed executable.
- Model traffic goes to loopback first.
- No real Google API key is required by local mode.
- Static Gemini response translation works.
- Static Gemini SSE translation works.
- llama.cpp text inference works.
- llama.cpp streaming works.
- Tool declaration/call/result round trips work with a tested local model.
- CLI confirmations and policies remain active.
- Token counting is real for the active model or the unsupported state is
  explicit.
- Bridge/backend failures cannot fall back to Google.
- Existing native system settings/defaults remain effective.
- Secrets and prompts are not logged by default.
- Local bridge files are removable without repairing `Gemini CLI`.
- Installed local artifacts match the accepted review SHA.
- A dedicated reviewed tag still points to that accepted implementation SHA.

Required before claiming broader compatibility:

- structured output passes dedicated tests,
- media passes dedicated tests for a multimodal model,
- embeddings are implemented if real CLI usage requires them,
- Ollama passes its macOS and Ubuntu profile tests,
- full external-network isolation passes a separate egress test before the word
  "offline" is used without qualification.

## Explicit deferred work

These items can be valuable later but do not block the first local agent path.

- Gemini Live/Bidi WebSocket translation.
- Native Termux Ollama repair.
- Remote backend hosting.
- LAN access to the bridge.
- Multi-user authentication for the bridge.
- Automatic local model downloads.
- Automatic hardware-based model selection.
- Model benchmarking and recommendation UI.
- Provider abstraction patches inside upstream `Gemini CLI`.
- A permanent GitHub distribution of this local customization.

## Stop conditions

Stop implementation and return to planning if any of these conditions occur.

- `GOOGLE_GEMINI_BASE_URL` no longer routes the installed version to localhost.
- Local mode requires modifying official package files.
- Normal `gemini` behavior changes as a side effect.
- The bridge must receive or persist a real Google credential.
- Local mode would need to shadow existing native system settings/defaults
  without an accepted preservation/composition strategy.
- A required `Gemini CLI` feature depends on an untranslatable private protocol.
- Tool confirmation would need to be bypassed to make a local model work.
- The selected backend cannot provide reliable tool-call structure for the
  intended agent workflow.
- Upstream changes invalidate the accepted provider seam before installation.

A stop condition does not authorize a source fork automatically. It requires a
new architecture review.

## Next steps

The immediate next step is review of this plan, not implementation. After the
plan is accepted, create the temporary implementation branch from the accepted
plan commit and begin with the localhost request-capture gate against the actual
Termux `Gemini CLI` `0.55.1` installation.