# C4 production-model acceptance

C4 is the final model-selection and real-device acceptance phase for
`gemini-local`. It starts from the completed C3 lifecycle documentation head:

`accepted/gemini-local-c3-final-docs-v1` -> `d5da3f6fe9e90c8844e1ef7bdf3e91134098bbcc`

The bridge, managed llama-server lifecycle, Android ownership verification,
Termux full-chain execution, and no-hosted-fallback boundary were already
accepted before C4. C4 does not reopen or weaken those boundaries merely to
accommodate a model.

## Device-tested baseline

**PASS — the original C4 real-device acceptance is complete at the exact
executable/test head below. The current PR head contains later production
review hardening and is not yet device-accepted.**

Last real-device-tested executable/test head:

`68d9ca71707341eb01bf7f9f3c8ccf9d99efe367`

Selected production local model:

```text
source repository: HauhauCS/Qwen3.5-4B-Uncensored-HauhauCS-Aggressive
source revision: c09cdbcdb1fefad6d335809d445621b5f5ba0c6e
license: Apache-2.0
base model: Qwen/Qwen3.5-4B
filename: Qwen3.5-4B-Uncensored-HauhauCS-Aggressive-Q6_K.gguf
quantization: Q6_K
byte size: 3464055136
SHA-256: ba93c21300854075ab42655bc30dca82c7c6c958f511d1ec9ea2b3e750b4b75f
backend identity: qwen3.5-4b-uncensored-q6k
```

Accepted Android managed-launch policy:

```text
-c 8192
-np 1
--no-warmup
```

Production launch leaves reasoning enabled. `--reasoning off` was used only in
a deterministic direct-response evidence probe and is not part of the managed
production argv.

The prior Qwen2.5-0.5B GGUF remains smoke/plumbing evidence only. Q4_K_M is a
fallback candidate, not the selected production model. Qwen3.6 was reviewed,
but the currently available open-weight sizes were not viable for the accepted
capacity envelope of this phone.

## Frozen boundaries

C4 preserves all accepted C3 properties:

- official Gemini CLI host remains pinned at 0.55.1;
- inference stays local through the accepted Gemini/GenAI <-> llama.cpp
  compatibility adapter;
- backend identity remains the real local-model identity and is never
  rebranded as Gemini;
- backend origin remains literal loopback only;
- no hosted Gemini fallback exists on any failure path;
- no Gemini credential or arbitrary caller header reaches llama-server;
- managed llama-server startup/reuse/status/stop/restart retains hash-pinned
  process ownership checks;
- `vendor/phase-b/*` and `PROVENANCE.json` remain immutable;
- normal `gemini` and the pre-existing Ollama installation remain untouched;
- no GGUF or llama.cpp binary is committed to this repository;
- no package-manager install/update is implicit in model acceptance.

## C4-0: read-only device capacity/source gate — PASS

Actual Android/Termux evidence recorded before the production-model download:

- filesystem: 101 GiB total, 94 GiB used, 6.7 GiB available, 94% used;
- RAM: 10 GiB total;
- swap: 15 GiB total;
- existing C3 smoke-model directory: about 470 MiB;
- pinned llama.cpp build: about 960 MiB;
- `gemini-local status`: exit 0, managed-running, healthy, managed, owned
  process verified;
- normal Gemini preserved at version 0.55.1;
- existing smoke GGUF: Qwen2.5-0.5B, about 469 MiB.

### Qwen3.6 viability review

Qwen3.6 was explicitly evaluated rather than ignored. The available official
open-weight releases and their uncensored GGUF derivatives were substantially
larger than this phone's accepted storage/runtime envelope. C4 therefore
rejected Qwen3.6 for this device at current capacity. It can be revisited if a
smaller release appears or the target hardware/storage changes.

### Qwen3.5 selection rationale

Candidates considered included larger 9B and higher-precision 4B variants, but
the 4B Q6_K artifact provided the best accepted balance of model quality and
remaining phone headroom. Publisher claims about uncensoring/refusal rate and
capability preservation are treated as claims, not independent proof; the C4
fitness gate below is the device-side evidence used for acceptance.

## C4-1: verified production GGUF download — PASS

The selected Q6_K artifact was downloaded to a temporary `.part` path and was
promoted only after both identity checks passed.

Observed device evidence:

- download exit: 0;
- expected byte size: 3,464,055,136;
- actual byte size: 3,464,055,136;
- expected SHA-256:
  `ba93c21300854075ab42655bc30dca82c7c6c958f511d1ec9ea2b3e750b4b75f`;
- actual SHA-256 matched exactly;
- final GGUF mode was set read-only (`0400`);
- post-download filesystem state was approximately 101 GiB total, 98 GiB
  used, 3.4 GiB available.

No package install/update, unrelated deletion, model replacement, or server
mutation was performed as part of the download gate.

## C4-2: direct llama-server proof — PASS

The exact selected Q6_K bytes were tested with the existing pinned llama.cpp
build.

The first unconstrained launch terminated during model initialization before
`model loaded` / `listening`. No kernel OOM evidence was available, so C4 does
not label that event a proven OOM.

A bounded retry established the mobile-safe launcher policy:

```text
-c 8192
-np 1
--no-warmup
```

With those bounds, the exact model loaded successfully and became healthy on
Android. Observed evidence included:

- loopback listener only on `127.0.0.1:8090`;
- exact backend identity `qwen3.5-4b-uncensored-q6k`;
- `n_slots = 1`;
- `n_ctx_slot = 8192`;
- `model loaded` observed in the real llama-server log;
- deterministic direct completion returned exactly `C4_Q6K_FINAL_OK`;
- direct response reported `finish_reason:"stop"`;
- loaded-memory snapshot left roughly 3.2 GiB RAM available and about 12 GiB
  swap free;
- the small deterministic response generated at about 11.96 tokens/second.

For the exact-token direct probe only, `--reasoning off` was added to make the
output deterministic. Production managed launch does not contain that flag.

## Managed-launch implementation — PASS

Host implementation commit:

`c5c69103f64abd30a3bcc1471e0af0eb7af8b79b`

The production launcher owns the Android-specific memory controls. Android/
Termux appends exactly `-c 8192 -np 1 --no-warmup`; Linux and other non-Android
platforms retain the accepted pre-C4 argv.

The change did not add a generic `serverArgs` escape hatch and did not add
`--reasoning off`. Loopback binding, `--offline`, `--no-webui`, `shell:false`,
sanitized child environment, hash-pinned artifacts, no hosted fallback, and
managed-process ownership verification remain intact.

Host verification at this stage included:

- focused managed/C3/C4 tests: 10/10 pass;
- complete bridge suite: 163 pass, 0 fail, 1 intentional skip (164 total);
- all bridge `.mjs` syntax: 34/34;
- installer/uninstaller `bash -n`: 2/2;
- `vendor/phase-b/*` and `PROVENANCE.json`: unchanged.

## C4-3: ordinary managed full-chain proof — PASS

The reviewed managed-launch change was installed on the real Android/Termux
device, and the local configuration was switched from the 0.5B smoke model to
the exact verified Qwen3.5 4B Q6_K artifact.

Starting from a stopped backend, an ordinary command:

```text
gemini-local <prompt>
```

automatically started the managed llama-server and completed the real chain:

```text
real pinned Gemini CLI
  -> local Gemini/GenAI compatibility adapter
  -> managed loopback llama-server
  -> Qwen3.5 4B Q6_K
```

Observed evidence:

- exact acceptance response `C4_MANAGED_FULL_CHAIN_OK`;
- prompt exit 0;
- exact-content check exit 0;
- backend status `managed-running`;
- backend healthy: yes;
- managed: yes;
- `Owned process verified: yes`;
- exact managed Android argv included `-c 8192 -np 1 --no-warmup`;
- production argv did not contain `--reasoning off`;
- normal Gemini remained version 0.55.1.

## C4-4: managed lifecycle proof — PASS

The real device proved the lifecycle expected for normal use:

- a second ordinary prompt returned `C4_REUSE_OK` with exit 0;
- the managed PID stayed unchanged during reuse;
- `gemini-local stop` terminated the verified owned backend and released port
  8090;
- `gemini-local restart` created a new healthy managed PID;
- the restarted process still used the selected Q6_K model and accepted Android
  bounds;
- ownership verification remained `yes`;
- normal Gemini remained preserved.

The final lifecycle machine summary was all-zero across reuse/content,
same-PID, stop, old-PID-down, port-down, restart, health, restart-status,
new-PID, and normal-Gemini preservation checks.

## C4-5: practical model fitness — PASS with one documented miss

C4 did not accept the model merely because it could load. It exercised the
selected model through ordinary `gemini-local` use.

### Instruction/reasoning probe

The constrained ordering task returned the exact expected answer `DBACE` with
prompt/content exits 0.

### Architecture/identity probe

The model correctly described the running inference backend as Qwen3.5 through
llama.cpp, distinguished the local Qwen model from Gemini, and described local
loopback inference with no hosted-Gemini fallback.

### Coding probe

The first URL-parser challenge exposed a genuine model logic error plus a
Markdown-fence compliance miss. That failure is intentionally retained as
quality evidence rather than hidden.

A second executable CommonJS coding challenge passed extraction, syntax, and
semantic tests. `C4_CODE_FITNESS_2_OK` was observed, with final machine summary:

```text
prompt=0 extract=0 syntax=0 semantic=0 status=0
```

Assessment: the selected Qwen3.5 4B Q6_K model is accepted as the current free
local default. It is useful but not infallible as a coding model, and the bridge
remains deliberately model-swappable so a stronger compatible local model can
replace it later without redesigning the Gemini-local transport.

## Final-suite stale C3 fixture correction

The first final-regression run exposed one stale C3 expected-argv fixture in
`test/c3-device-finalization.test.mjs`. It still hardcoded the pre-C4 Android
argv ending at `--no-webui --offline`, while the accepted Android production
argv now correctly appends `-c 8192 -np 1 --no-warmup`.

This was a test-fixture defect, not a production runtime defect.

Test-only correction commit:

`68d9ca71707341eb01bf7f9f3c8ccf9d99efe367`

The correction imports `buildManagedLlamaServerArgs`, uses the same config
passed to `ensureBackendReady`, and compares captured argv against the current
platform-aware builder. Independent assertions for the executable,
`shell:false`, detached process behavior, credential stripping, and proxy
stripping remain. The dedicated C4 platform-policy test remains independent.
No production behavior changed in this correction.

## C4-6: baseline Android/Termux regression/freeze gate — PASS at `68d9ca717...`

The corrected exact head
`68d9ca71707341eb01bf7f9f3c8ccf9d99efe367` was fetched, checked out detached,
reinstalled, and re-executed on the real Android/Termux device.

The gate printed:

```text
C4-6 PASS — FINAL DEVICE REGRESSION GATE GREEN
```

That gate only prints PASS when its acceptance checks are all zero. The device
gate covered:

- exact expected checkout SHA;
- clean worktree;
- selected production GGUF SHA;
- pinned llama-server SHA;
- pre-suite managed-running/healthy/owned state;
- focused C3/C4 regressions;
- complete default bridge suite;
- complete suite using the real pinned Gemini root;
- all `.mjs` syntax checks;
- installer/uninstaller shell syntax;
- `git diff --check`;
- immutable `vendor/phase-b/*` / `PROVENANCE.json` boundary;
- post-suite backend health/status;
- unchanged managed PID during regression execution;
- final owned-process verification;
- normal Gemini path/version preservation.

That evidence establishes `68d9ca71707341eb01bf7f9f3c8ccf9d99efe367`
as the last accepted device-tested baseline. It does **not** validate later
production-code commits.

## Post-acceptance Cloud Codex hardening — DEVICE REVALIDATION REQUIRED

Cloud Codex subsequently found a P2 in the healthy managed-backend reuse path:
a healthy process started under an older launcher policy could be reused before
current config and launcher policy were compared.

The bounded correction is:

- runtime fix: `8997b1bd60459f83fa4077385524c166f5965089`;
- regression coverage: `c9a991bdaa20a48ceb0fd5a58e3a83ffdd5ead12`.

The corrected state records a SHA-256 fingerprint of the exact launcher-owned
argv. Before healthy managed reuse, the runner now compares current protocol
config, lightweight pinned launch identity, and the current launcher argv
policy against the recorded state. Legacy state without a policy fingerprint
is intentionally incompatible. A mismatch fails closed with
`MANAGED_STATE_CONFLICT` and requires `gemini-local restart`.

The healthy fast path reads configured server/model identity without re-hashing
the multi-GiB GGUF on every prompt. Full server/model SHA verification remains
mandatory before any new managed spawn. Restart may replace a differently
configured prior managed process only after the existing ownership verifier
proves that the recorded process is still the owned llama-server.

Because this changes production behavior after the prior C4-6 device gate,
**the current review-hardening head is not accepted yet**. Fresh host validation
and a fresh Android/Termux final gate must pass on the final executable/test
head before any new C4 acceptance ref is created. Until then, the permanent
accepted executable boundary remains `68d9ca71707341eb01bf7f9f3c8ccf9d99efe367`.

## Repo acceptance / freeze state

The original C4 model/runtime acceptance is preserved at the baseline SHA above,
but the current PR head is deliberately **not frozen as accepted** while the
post-review production hardening awaits fresh validation.

Do not create or move a C4 executable/device acceptance ref to the review
hardening head until the fresh device gate is green. After that gate, reconcile
this document with the newly tested SHA, create the corresponding acceptance
ref, and only then close PR #9 unmerged unless a separate integration decision
explicitly authorizes a merge.

Do not merge PR #9 unless a separate integration decision is explicitly
authorized.

## Explicitly deferred beyond C4

C4 does not add interactive Gemini mode, slash commands, local tool/function
execution, embeddings, multimodal routing, automatic model downloads, Android
boot persistence, or arbitrary caller Gemini argv forwarding.