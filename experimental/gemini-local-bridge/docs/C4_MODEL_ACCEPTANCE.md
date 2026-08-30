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

`b6943932b46eb10a96c791bd1030a10dac923eea`

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

Before the production-model download, the real Android/Termux target reported:

- filesystem: 101 GiB total, 6.7 GiB available;
- RAM: 10 GiB total;
- swap: 15 GiB total;
- existing C3 smoke-model directory: about 470 MiB;
- pinned llama.cpp build: about 960 MiB;
- `gemini-local status`: managed-running / healthy / managed / owned;
- normal Gemini: 0.55.1.

Qwen3.6 was explicitly evaluated but the available open-weight sizes were not
viable for the accepted phone capacity envelope. Qwen3.5 9B was also rejected
as storage-tight. The 4B Q6_K artifact provided the accepted quality/capacity
balance. Qwen2.5-0.5B remains smoke/plumbing evidence only, and Q4_K_M remains a
fallback candidate rather than the selected model.

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

Observed evidence included:

- exact Q6_K server healthy in about 12 seconds;
- listener only on `127.0.0.1:8090`;
- `n_slots = 1`;
- `n_ctx_slot = 8192`;
- deterministic direct-response probe returned `C4_Q6K_FINAL_OK`;
- loaded-memory snapshot left roughly 3.2 GiB RAM available and about 12 GiB
  swap free;
- small-response generation measured about 11.96 tokens/second.

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

## Baseline device gate and later Cloud hardening

The original final-device baseline was established at:

`68d9ca71707341eb01bf7f9f3c8ccf9d99efe367`

That baseline included the test-only correction of a stale C3 expected-argv
fixture and produced `C4-6 PASS — FINAL DEVICE REGRESSION GATE GREEN`.

Independent Cloud Codex review then found multiple real managed-lifecycle race,
status-consistency, and portability issues after that baseline. These were
fixed incrementally rather than waived. The final executable head includes:

- current-launch identity/policy checks before managed reuse/status success;
- dead-state ordering and re-read protections;
- exclusive managed-launch ownership claim before spawn;
- atomic normal claim release;
- successor-safe stale-claim reclamation;
- bounded retry handling for public-claim handoffs and empty stale-reclamation
  windows;
- no-clobber managed-state publication without hard-link dependency;
- explicit state-publication coordination so concurrent readers never consume
  legitimate partial ownership state;
- safe rollback/successor preservation;
- bounded acquisition contention;
- preserved Android/non-Android argv policy and all security boundaries above.

The real Android target then exposed one additional portability defect that the
host could not reproduce: `link(2)` inside the Termux private runtime returned
`EACCES`. The managed-state lifecycle was corrected to require no hard links.
Cloud review then found and drove correction of the resulting partial-state
visibility window. The final reviewed executable candidate became:

`b6943932b46eb10a96c791bd1030a10dac923eea`

## Final host verification at `b6943932...` — PASS

Host-side verification of the final executable candidate recorded:

- C4 managed-launch suite: 49/49 pass;
- focused C3+C4: 56/56 pass;
- complete bridge suite: 209 pass, 0 fail, 1 conditional real-pinned-Gemini
  skip (210 total);
- `.mjs` syntax: 37/37;
- installer/uninstaller `bash -n`: 2/2;
- `git diff --check`: pass;
- protected `vendor/phase-b` and `PROVENANCE.json`: unchanged;
- production contains no `linkSync`, generic `serverArgs`, or production
  `--reasoning off`.

The host-only skip existed solely because that host did not have the configured
real pinned Gemini root. The real-device gate below closes that gap.

## Final Android/Termux revalidation at `b6943932...` — PASS

The exact final executable head was fetched, checked out detached, installed,
and exercised on the real Android/Termux target. The repository worktree was
clean.

### Sequential cold start

Starting from a genuinely stopped backend with no state/claim/server process,
an ordinary prompt returned exactly:

`C4_PORTABLE_STATE_OK`

with exit 0.

Post-start evidence:

- backend status: `managed-running`;
- healthy: yes;
- managed: yes;
- owned process verified: yes;
- authoritative managed state present;
- launch claim absent;
- state-publication marker absent.

This proves the final no-hard-link state publication works on the actual Termux
filesystem.

### Exact live process policy

The real managed server used:

- executable:
  `/data/data/com.termux/files/home/llama-cpp-c3/build/bin/llama-server`;
- model:
  `/data/data/com.termux/files/home/c4-models/Qwen3.5-4B-Uncensored-HauhauCS-Aggressive-Q6_K.gguf`;
- `--host 127.0.0.1`;
- `--port 8090`;
- `-a qwen3.5-4b-uncensored-q6k`;
- `--no-webui`;
- `--offline`;
- `-c 8192`;
- `-np 1`;
- `--no-warmup`;
- no `--reasoning off`.

Exactly one matching llama-server process existed.

### Concurrent cold start

The verified owned backend was stopped, its old PID went down, and two ordinary
`gemini-local` prompts were started concurrently.

Observed result:

- one contender failed safely with `MANAGED_LAUNCH_IN_PROGRESS`;
- the other succeeded with exact `C4_CONCURRENT_B`;
- exactly one new llama-server process existed afterward;
- backend was managed-running / healthy / managed / owned;
- launch claim absent;
- state-publication markers absent;
- subsequent ordinary prompt returned `C4_AFTER_RACE_OK`;
- same PID was preserved on stable reuse.

This directly proves the final launch serialization and portable state
publication operate together correctly on the real target.

### Final device regression suites

On the exact final executable head:

- focused C3+C4 suite: exit 0;
- default complete bridge suite: 210 total, 209 pass, 0 fail, 1 expected
  conditional skip;
- complete bridge suite with the real pinned Gemini 0.55.1 root: **210/210
  pass, 0 fail, 0 skip**;
- all `.mjs` syntax checks: exit 0;
- installer/uninstaller shell syntax: 0/0;
- `git diff --check`: exit 0.

The real pinned-Gemini device run therefore closes the only host-side
conditional integration gap.

### Final integrity snapshot

Final device integrity evidence:

```text
executable/test SHA:
b6943932b46eb10a96c791bd1030a10dac923eea

llama-server SHA-256:
94f9aa667e042be00f8270cc8ae384db0dcf1587b9cac45cc22ce8c85704d594

selected GGUF SHA-256:
ba93c21300854075ab42655bc30dca82c7c6c958f511d1ec9ea2b3e750b4b75f

vendor/phase-b Git tree:
1291c0266e334b7c78ac8a96f1184a16a9657d08

PROVENANCE.json Git blob:
4d330a6056decdd17dbf52b6bcfcc85cb84ba178
```

Both configured artifact-hash comparisons returned `yes`. Final status was
managed-running / healthy / managed / owned, with exactly one llama-server
process. The launch-claim path was absent, publication markers were absent,
normal Gemini remained `/data/data/com.termux/files/usr/bin/gemini` version
0.55.1, and the repository worktree was clean.

## Acceptance/freeze state

C4 executable/device acceptance is therefore frozen at:

`b6943932b46eb10a96c791bd1030a10dac923eea`

The acceptance refs are intentionally separate:

- executable/device ref: `accepted/gemini-local-c4-device-proof-v1`;
- final documentation ref: `accepted/gemini-local-c4-final-docs-v1`.

The executable/device ref must point to the exact device-tested executable head
above. The final-docs ref points to the documentation-only reconciliation commit
containing this completed record.

PR #9 is an isolated C4 review/acceptance vehicle and is not intended to be
merged into `main` as part of this acceptance. After the refs are pinned and the
final review thread is resolved, close PR #9 **unmerged** unless a separate
integration decision explicitly authorizes a merge.

## Explicitly deferred beyond C4

C4 does not add interactive Gemini mode, slash commands, local tool/function
execution, embeddings, multimodal routing, automatic model downloads, Android
boot persistence, or arbitrary caller Gemini argv forwarding.
