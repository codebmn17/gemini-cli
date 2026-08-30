# C4 production-model acceptance

C4 is the final production-model selection and real-device acceptance phase for
`gemini-local`. It starts from the completed C3 documentation boundary:

`accepted/gemini-local-c3-final-docs-v1` -> `d5da3f6fe9e90c8844e1ef7bdf3e91134098bbcc`

C4 does not reopen the accepted C1-C3 trust boundaries. Official Gemini CLI
remains the host/interface; inference remains local through the accepted
Gemini/GenAI <-> llama.cpp compatibility adapter; the actual backend identity
remains the real local model identity and is never represented as Gemini.

## Final C4 verdict

**PASS — final executable/test acceptance is complete on the real Android/
Termux target at:**

`ef7a7cebf24ad38fd439180b00a800c0d65c3dfd`

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

Production reasoning remains enabled. `--reasoning off` was used only for one
deterministic direct-response evidence probe and is absent from production
managed argv.

## Frozen boundaries

The final C4 tree preserves the accepted boundaries:

- official Gemini CLI host pinned at 0.55.1;
- local inference through llama.cpp on literal `127.0.0.1` only;
- no hosted-Gemini fallback on any failure path;
- no Gemini credential/cookie/arbitrary caller-header forwarding to llama-server;
- backend identity remains `qwen3.5-4b-uncensored-q6k`, never renamed Gemini;
- server/model launch artifacts remain path- and SHA-256-pinned;
- full artifact hashing remains mandatory before a new managed spawn;
- ownership verification remains mandatory before managed process signaling;
- Android argv remains launcher-owned and contains exactly the accepted mobile
  bounds above in addition to the accepted loopback/offline/no-webui policy;
- no generic `serverArgs` escape hatch;
- no production `--reasoning off`;
- C2 six-key local config remains unchanged;
- `vendor/phase-b/*` and `PROVENANCE.json` remain immutable;
- normal `gemini` and the existing Ollama installation remain untouched;
- no GGUF/model weights or llama.cpp binary are committed;
- no package-manager install/update is implicit in C4.

## C4-0: read-only capacity/source gate — PASS

Before the production-model download, the real Android/Termux target reported
sufficient bounded capacity for the selected artifact. Qwen3.6 and Qwen3.5 9B
were evaluated but rejected for the accepted phone envelope. Qwen3.5 4B Q6_K
provided the accepted quality/capacity balance. Qwen2.5-0.5B remains
smoke/plumbing evidence only, and Q4_K_M remains a fallback candidate rather
than the selected model.

## C4-1: verified Q6_K download — PASS

The exact Q6_K artifact was downloaded to a temporary `.part` path and promoted
only after both size and hash checks passed.

Observed real-device evidence:

- download exit 0;
- expected/actual byte size: 3,464,055,136;
- expected/actual SHA-256:
  `ba93c21300854075ab42655bc30dca82c7c6c958f511d1ec9ea2b3e750b4b75f`;
- final model file mode: `0400`;
- no package install/update or unrelated deletion was performed.

## C4-2: direct real-model proof — PASS

The first unconstrained Q6_K launch terminated during initialization before
`model loaded` / `listening`. No kernel OOM evidence was available, so that
attempt is not labeled a proven OOM.

A controlled retry using the final Android bounds proved the exact model works:

```text
-c 8192
-np 1
--no-warmup
```

Observed evidence included an exact healthy Q6_K server on literal loopback,
one 8192-token slot, deterministic direct response `C4_Q6K_FINAL_OK`, and
usable bounded memory/generation performance on the real phone.

## C4-3/C4-4: managed full chain and lifecycle — PASS

The production configuration was switched from the C3 smoke model to the exact
Q6_K artifact. From a stopped backend, ordinary `gemini-local` use completed:

```text
real pinned Gemini CLI 0.55.1
  -> local Gemini/GenAI compatibility adapter
  -> managed loopback llama-server
  -> Qwen3.5 4B Q6_K
```

Observed evidence included:

- exact full-chain response `C4_MANAGED_FULL_CHAIN_OK`;
- managed-running / healthy / managed;
- `Owned process verified: yes`;
- exact Android argv including `-c 8192 -np 1 --no-warmup`;
- no production `--reasoning off`;
- same-PID reuse response `C4_REUSE_OK`;
- verified stop of the owned process;
- restart to a new healthy owned PID;
- normal Gemini preserved at 0.55.1.

## C4-5: practical model fitness — PASS with one documented miss

The selected model was exercised through ordinary `gemini-local` use rather
than accepted only because it could load.

- instruction/reasoning probe returned exact `DBACE`;
- architecture/identity probe correctly distinguished the local Qwen backend
  from Gemini and described local llama.cpp/loopback inference;
- first URL-parser coding challenge exposed a genuine model logic error plus a
  Markdown-fence compliance miss, retained as evidence rather than hidden;
- second executable CommonJS coding probe passed extraction, syntax, and
  semantic checks and returned `C4_CODE_FITNESS_2_OK`.

Assessment: Qwen3.5 4B Q6_K is accepted as the current free local default. It is
usable but not infallible as a coding model. The bridge remains model-swappable
for future stronger compatible local models.

## Managed-lifecycle hardening history

The original final-device baseline was established at:

`68d9ca71707341eb01bf7f9f3c8ccf9d99efe367`

Independent Cloud Codex review then found multiple real managed-lifecycle race,
status-consistency, and portability issues. These were fixed incrementally
rather than waived. The hardening chain established:

- current-launch identity/policy checks before managed reuse/status success;
- dead-state ordering and re-read protections;
- exclusive managed-launch ownership claim before spawn;
- atomic normal claim release;
- successor-safe stale-claim reclamation;
- bounded retry handling for public-claim handoffs and empty stale-reclamation
  windows;
- no-clobber managed-state publication;
- no hard-link requirement after real Termux exposed `link(2) -> EACCES`;
- explicit state-publication coordination so concurrent readers never consume
  legitimate partial ownership state;
- safe rollback/successor preservation;
- bounded acquisition contention;
- preserved Android/non-Android argv policy and all security boundaries above.

The first fully revalidated post-hardening executable boundary was:

`b6943932b46eb10a96c791bd1030a10dac923eea`

That exact tree passed stopped-backend cold start, exact live argv/process
inspection, concurrent cold-start serialization, stable same-PID reuse, full
Android suites, real pinned-Gemini integration, artifact identities, runtime
cleanliness, and a clean worktree.

After that acceptance was documented, Cloud Codex found one additional P2:
managed state could still be classified as live from numeric PID liveness alone
if Android/Linux recycled the PID for a different process. The final executable
correction for that finding was:

`864f445832e7185e58d57152965252497b977e45`

It classifies recorded process identity as dead/stale, recycled/stale,
matching-live, or unknown using the recorded and current proc start ticks where
available. A positively recycled PID follows stale-state cleanup; unknown proc
identity remains conservative/fail-closed. Full ownership verification remains
required before signaling.

That executable became an earlier accepted and device-tested boundary. A later
Cloud Codex P2 found that explicit restart could stop a verified healthy managed
backend before discovering that the current managed launch configuration was
missing, malformed, or otherwise unusable. The final executable correction is:

`ef7a7cebf24ad38fd439180b00a800c0d65c3dfd`

Commit purpose: `C4: preflight managed restart before teardown`.

For a recorded managed process that is not positively dead or recycled,
explicit restart now fully validates the current managed launch configuration,
server/model paths, and pinned SHA-256 artifacts before SIGTERM or SIGKILL.
Ownership is reverified after full artifact hashing and immediately before
SIGTERM. Missing, malformed, or unusable launch configuration therefore fails
without tearing down the working process. Positive dead/recycled-state cleanup
remains ahead of this preflight and never signals a stale or unrelated PID.

## Earlier host verification at `864f445...` — PASS

Host-side verification of the recycled-PID correction recorded:

- deterministic pre-fix reproduction: 0/1 pass, exit 1, with the stale record
  incorrectly reaching `MANAGED_STATE_CONFLICT`;
- C4 managed-launch suite: 58/58 pass;
- focused C3+C4: 65/65 pass;
- complete bridge suite: 218 pass, 0 fail, 1 conditional real-pinned-Gemini
  skip (219 total);
- all reported host `.mjs` syntax checks: 37 pass;
- installer/uninstaller `bash -n`: 2/2;
- `git diff --check`: pass;
- protected `vendor/phase-b` tree and `PROVENANCE.json` blob unchanged;
- production contains no hard-link dependency, generic `serverArgs`, or
  production `--reasoning off`.

The host-only skip existed solely because that host did not have the configured
real pinned Gemini root. The real-device gate below closes that gap.

## Earlier Android/Termux revalidation at `864f445...` — PASS

The exact executable head was fetched from the remote branch, checked out
detached, installed, and exercised on the real Android/Termux target. The
repository worktree was clean.

### Gate 1: matching live process identity and exact-head reuse — PASS

Before installing the corrected executable, the existing real managed backend
was PID 7040. Its recorded proc start ticks and the actual Android
`/proc/7040/stat` start ticks were both `1301853`.

After installing exact `864f445...`:

- installed `managed-backend.mjs` SHA-256 matched the checked-out source;
- `gemini-local status` reported managed-running / healthy / managed / owned;
- PID remained 7040;
- ordinary prompt returned exact `C4_PID_MATCH_OK`, exit 0;
- PID remained 7040 after the prompt;
- recorded/current start ticks remained `1301853` / `1301853`;
- launch claim absent;
- state-publication marker absent.

This proves the new `matching-live` process-identity branch recognizes and
reuses the actual owned Android process rather than forcing a replacement.

### Gate 2: real Android recycled-PID proof — PASS

A deliberately isolated temporary HOME/runtime was used so the production
managed state was never modified. A harmless live `sleep 600` process was used
as the unrelated recycled-PID stand-in.

Observed real Android procfs evidence:

```text
innocent PID: 24518
actual /proc start ticks: 8469849
recorded fake start ticks: 8469850
ticks deliberately differ: yes
```

The exact corrected module then produced:

- status: `stale-state`;
- healthy: true;
- managed: true;
- reported PID: 24518;
- owned process verified: false;
- status call exit 0;
- stop result: `stale-state-removed`, `stopped=false`, exit 0;
- the innocent PID remained alive;
- the isolated fake state was removed;
- production managed state remained present and still referenced PID 7040.

This directly validates the Cloud-reported failure mode on the actual Android
procfs implementation: a live numeric PID with mismatched start ticks is
recognized as recycled/stale and is never signaled as the recorded managed
process.

### Gate 3: final exact-head regression/integrity gate — PASS

On exact `864f445...`:

- C4 managed-launch suite: 58/58 pass, exit 0;
- focused C3+C4 suite: 65/65 pass, exit 0;
- default complete bridge suite: 219 total, 218 pass, 0 fail, 1 expected
  conditional skip, exit 0;
- complete bridge suite with the real pinned Gemini CLI 0.55.1 root:
  **219/219 pass, 0 fail, 0 skip**, exit 0;
- bridge-local `.mjs` syntax checks: 34/34 pass, exit 0;
- installer/uninstaller shell syntax: 0/0;
- `git diff --check`: exit 0.

The real pinned-Gemini device run closes the host-side conditional integration
gap.

### Earlier accepted live production state and integrity snapshot

Final device integrity evidence:

```text
executable/test SHA:
864f445832e7185e58d57152965252497b977e45

llama-server SHA-256:
94f9aa667e042be00f8270cc8ae384db0dcf1587b9cac45cc22ce8c85704d594

selected GGUF SHA-256:
ba93c21300854075ab42655bc30dca82c7c6c958f511d1ec9ea2b3e750b4b75f

vendor/phase-b Git tree:
1291c0266e334b7c78ac8a96f1184a16a9657d08

PROVENANCE.json Git blob:
4d330a6056decdd17dbf52b6bcfcc85cb84ba178
```

Final status remained managed-running / healthy / managed / owned at PID 7040.
Recorded/current Android proc start ticks were both `1301853`. Both configured
artifact-hash comparisons returned `yes`. The launch-claim path was absent,
publication markers were absent, normal Gemini remained
`/data/data/com.termux/files/usr/bin/gemini` version 0.55.1, and the repository
worktree was clean.

## Final host verification at `ef7a7ce...` — PASS

Host-side verification of the restart-preflight correction recorded:

- deterministic pre-fix reproduction: the focused regression failed 0/1,
  exit 1, and captured SIGTERM before the missing launch configuration was
  discovered;
- C4 managed-launch suite: 68/68 pass, exit 0;
- focused C3+C4 suite: 75/75 pass, exit 0;
- complete bridge suite: 229 total, 228 pass, 0 fail, 1 declared conditional
  pinned-Gemini skip, exit 0;
- the real pinned Gemini host integration was unavailable because
  `GEMINI_LOCAL_TEST_PINNED_GEMINI_ROOT` was not configured;
- all 34 bridge-local `.mjs` files passed `node --check`; the same tracked count
  was later independently confirmed on the device;
- installer/uninstaller shell syntax: pass;
- `git diff --check`: pass;
- protected `vendor/phase-b` and `PROVENANCE.json` identities unchanged.

The initial macOS focused run encountered the pre-existing `/var` versus
`/private/var` temporary-path alias in the untouched C3 fixture. Re-running with
the same temporary directory canonicalized passed 75/75. This was a host fixture
path-identity issue, not a production defect, and no C3 file was changed.

## Final Android/Termux validation at `ef7a7ce...` — PASS

The exact executable/test head
`ef7a7cebf24ad38fd439180b00a800c0d65c3dfd` completed three final real-device
gates on Android 15 / Termux.

### Gate 1: exact-head install continuity — PASS

The remote branch head was fetched and verified exactly as
`ef7a7cebf24ad38fd439180b00a800c0d65c3dfd` before installation.

Before installation, production was managed-running / healthy / managed /
owned at PID 7040, with recorded/current proc start ticks `1301853` /
`1301853`.

After installation:

- PID remained 7040;
- recorded/current ticks remained `1301853` / `1301853`;
- authoritative state hash and launch-config hash were unchanged;
- installed `managed-backend.mjs` and launcher hashes/bytes matched the exact
  detached source;
- doctor and status exited 0;
- no launch claim or publication marker existed;
- normal Gemini remained `/data/data/com.termux/files/usr/bin/gemini` version
  0.55.1;
- the repository worktree remained clean.

This proves that installing the corrected executable did not itself disturb the
existing healthy managed process.

### Gate 2: restart-safety behavior — PASS

An isolated HOME/runtime and harmless live Android Node process exercised the
real procfs ownership verifier without risking production. The dummy identity
was:

```text
PID: 8919
executable: /data/data/com.termux/files/usr/bin/node
proc start ticks: 9431820
```

With the launch config missing, `gemini-local restart` failed with
`MANAGED_CONFIG_INVALID`, exit 5, and explicit restore/configure-before-retry
guidance. The dummy process remained alive and the isolated authoritative state
remained byte-identical.

With malformed launch JSON, restart again failed with
`MANAGED_CONFIG_INVALID`, exit 5, and the same correct remediation. The dummy
process remained alive and the isolated state remained byte-identical.

The isolated failure gate therefore returned `isolated_failure_gate=yes`.

One real production restart was then performed with the valid pinned Q6_K
launch configuration. Before restart, PID 7040 had matching recorded/current
ticks `1301853` / `1301853` and verified ownership. Restart exited 0 with result
`managed-started`. The replacement was PID 9490 with matching recorded/current
ticks `9433163` / `9433163`; the process identity changed, the old identity was
gone, exactly one managed llama-server existed, and status was managed-running /
healthy / managed / owned.

The exact live argv contained:

```text
-m <selected Q6_K GGUF>
--host 127.0.0.1
--port 8090
-a qwen3.5-4b-uncensored-q6k
--no-webui
--offline
-c 8192
-np 1
--no-warmup
```

Production contained no `--reasoning` flag. State server/model paths and
configured SHA-256 identities matched the pinned launch config. No launch claim
or publication marker remained.

The first Gate-2 wrapper printed `android_bounds_present=no` because its shell
wildcard pattern was incorrect. The captured cmdline already contained the
correct argv. A subsequent non-destructive adjudication parsed
`/proc/9490/cmdline` as NUL-delimited argv and returned:

```text
host_loopback=yes
context_8192=yes
parallel_1=yes
no_warmup=yes
offline=yes
no_webui=yes
reasoning_flag_absent=yes
android_bounds_present=yes
managed_process_count=1
claim_exists=no
publication_markers=none
worktree=clean
gate2_adjudication=yes
```

The initial `android_bounds_present=no` was therefore an evidence-harness false
negative, not a product failure.

### Gate 3: final comprehensive exact-head gate — PASS

At exact `ef7a7cebf24ad38fd439180b00a800c0d65c3dfd`:

- C4 managed-launch suite: 68/68 pass, exit 0;
- focused C3+C4 suite: 75/75 pass, exit 0;
- default complete bridge suite: 229 total, 228 pass, 0 fail, 1 expected
  conditional skip, exit 0;
- complete bridge suite with real pinned Gemini CLI 0.55.1: 229/229 pass,
  0 fail, 0 skip, exit 0;
- bridge-local `.mjs`: 34/34 pass, `tracked_mjs_count=34`, exit 0;
- installer/uninstaller shell syntax: 0 failures, both commands exit 0;
- `git diff --check`: exit 0.

Final production remained at PID 9490 with recorded/current proc start ticks
`9433163` / `9433163`, managed-running / healthy / managed / owned. Literal
loopback, context 8192, parallel 1, no-warmup, offline, and no-webui checks all
returned yes. The reasoning flag was absent, exactly one managed process
existed, the launch claim and publication markers were absent, and the worktree
was clean.

Final artifact and protected-object identities were:

```text
llama-server SHA-256:
94f9aa667e042be00f8270cc8ae384db0dcf1587b9cac45cc22ce8c85704d594

selected GGUF SHA-256:
ba93c21300854075ab42655bc30dca82c7c6c958f511d1ec9ea2b3e750b4b75f

vendor/phase-b Git tree:
1291c0266e334b7c78ac8a96f1184a16a9657d08

PROVENANCE.json Git blob:
4d330a6056decdd17dbf52b6bcfcc85cb84ba178
```

Normal Gemini remained `/data/data/com.termux/files/usr/bin/gemini` version
0.55.1.

## Acceptance/freeze state

C4 executable/device acceptance is therefore frozen at:

`ef7a7cebf24ad38fd439180b00a800c0d65c3dfd`

The acceptance refs remain intentionally separate and must be moved only by the
authorized final reconciliation step:

- `accepted/gemini-local-c4-device-proof-v1` should ultimately point to
  `ef7a7cebf24ad38fd439180b00a800c0d65c3dfd`;
- `accepted/gemini-local-c4-final-docs-v1` should ultimately point to this new
  documentation-only reconciliation commit.

This new commit changes documentation only over `ef7a7ce...`; it does not create
a later executable/test boundary.

PR #9 remains an isolated C4 review/acceptance vehicle and is not intended to be
merged into `main`. It will be closed **unmerged** only after this final
documentation commit, the acceptance refs, review-thread resolution, and final
metadata check are complete.

## Explicitly deferred beyond C4

C4 does not add interactive Gemini mode, slash commands, local tool/function
execution, embeddings, multimodal routing, automatic model downloads, Android
boot persistence, or arbitrary caller Gemini argv forwarding.
