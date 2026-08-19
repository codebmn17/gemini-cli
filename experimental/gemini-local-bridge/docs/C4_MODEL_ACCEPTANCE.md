# C4 production-model acceptance

C4 is the final model-selection and device-acceptance phase for `gemini-local`.
It starts from the completed C3 lifecycle documentation head:

`accepted/gemini-local-c3-final-docs-v1` -> `d5da3f6fe9e90c8844e1ef7bdf3e91134098bbcc`

The bridge, managed llama-server lifecycle, Android ownership verification,
Termux full-chain execution, and no-hosted-fallback boundary are already
accepted. C4 must not reopen or weaken those boundaries merely to accommodate
a model.

## Goal

Replace the 0.5B Qwen smoke-test GGUF with a long-term local model that is
actually useful for normal `gemini-local` work on the validated Android/
Termux device, then pin and prove that exact model on-device.

The current preferred target family is **Qwen3.5**, with an uncensored GGUF
preferred if a candidate is technically sound and fits the device. Qwen3.6 is
also considered when a current release is technically viable on this phone.
The prior Qwen2.5-0.5B GGUF remains plumbing evidence only and is not a
production-model selection.

No third-party model is accepted by name alone. The exact repository,
revision, filename, byte size, license, quantization and SHA-256 must be
recorded before an acceptance ref is created.

## Frozen boundaries

C4 must preserve all accepted C3 properties:

- official Gemini CLI host remains pinned at 0.55.1;
- inference stays local through the already accepted Gemini<->llama.cpp
  compatibility adapter;
- backend identity remains the real local model identity and is never
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

## C4-0: read-only device capacity gate

Before selecting a quant or downloading anything, record current device state:

```sh
df -h "$HOME"
free -h 2>/dev/null || cat /proc/meminfo | head -3

gemini-local status
command -v gemini
gemini --version
```

### Actual device evidence — 2026-08-19

The read-only gate was executed on the already accepted Android/Termux device.
Observed state:

- filesystem: 101 GiB total, 94 GiB used, 6.7 GiB available, 94% used;
- RAM: 10 GiB total, 7.6 GiB used, 720 MiB free, 2.8 GiB available;
- swap: 15 GiB total, 4.3 GiB used, 11 GiB free;
- existing C3 smoke-model directory: 470 MiB;
- existing pinned llama.cpp build: 960 MiB;
- `gemini-local status`: exit 0, managed-running, healthy, managed, owned
  process verified;
- normal Gemini preserved at version 0.55.1;
- existing smoke GGUF remains the 469 MiB Qwen2.5-0.5B file.

A candidate that cannot leave a reasonable storage margin or cannot complete
real prompts within bounded local-inference deadlines is rejected rather than
forcing the device into a fragile state.

## C4-1: candidate selection

Selection order:

1. Prefer a Qwen3.5 uncensored GGUF that is compatible with the already pinned
   llama.cpp build and whose quantization fits this device.
2. Prefer quality-preserving K-quants when capacity permits; step down in
   quantization only when the device evidence requires it.
3. If the preferred uncensored candidate is malformed, incompatible, too
   large, materially unstable, or unacceptably slow, reject it and test the
   next bounded candidate. Do not patch the accepted bridge to hide a broken
   model package.
4. The accepted backend name must identify the real selected model/quant; it
   must not use a Gemini-branded alias.

### Qwen3.6 viability review

Current official Qwen3.6 open-weight releases are 27B dense and 35B-A3B MoE.
They are not viable on this device at the present capacity. The 27B
uncensored GGUF family is about 10 GiB even at its smallest listed IQ2_M quant
and about 17.5 GiB at Q4-class quality. The 35B-A3B uncensored family is about
11.7 GiB even at IQ2_M and about 21.2 GiB at Q4_K_M. Both exceed the phone's
current 6.7 GiB free storage before runtime headroom is considered.

Therefore **Qwen3.6 is evaluated but rejected for C4 on this device**, not
because of model quality, but because the currently released sizes cannot fit
the accepted storage/RAM envelope. Revisit if a smaller official Qwen3.6
release appears or the target hardware changes.

### Qwen3.5 candidates considered

- Qwen3.5-9B uncensored Q4_K_M: about 5.63 GiB. This technically fits the raw
  filesystem number but would leave roughly 1 GiB free before runtime/cache/
  Android operating margin. It is therefore a stretch candidate, not the first
  production choice on the current phone.
- Qwen3.5-4B uncensored Q8_0: 4.48 GiB. Better precision but leaves materially
  less device storage and runtime headroom than necessary.
- Qwen3.5-4B uncensored Q4_K_M: 2.71 GiB. Comfortable footprint and viable
  fallback if Q6_K proves too heavy.
- **Qwen3.5-4B uncensored Q6_K: 3.46 GiB. Selected first C4 candidate.** It
  provides a stronger quant than Q4_K_M while leaving roughly 3.2 GiB of the
  currently free filesystem capacity before any later cleanup of the smoke
  model/build.

The 4B base model is an official Qwen3.5 model with 262,144-token native
context. The selected uncensored derivative is Apache-2.0 and identifies
Qwen/Qwen3.5-4B as its base. Claims such as "0/465 refusals" and "zero
capability loss" are publisher claims, not treated as independent benchmark
proof; C4 practical fitness testing remains mandatory.

### Selected first candidate — immutable source identity

```text
source repository: HauhauCS/Qwen3.5-4B-Uncensored-HauhauCS-Aggressive
source revision: c09cdbcdb1fefad6d335809d445621b5f5ba0c6e
license: Apache-2.0
base model: Qwen/Qwen3.5-4B
filename: Qwen3.5-4B-Uncensored-HauhauCS-Aggressive-Q6_K.gguf
quantization: Q6_K
byte size: 3464055136
SHA-256: ba93c21300854075ab42655bc30dca82c7c6c958f511d1ec9ea2b3e750b4b75f
```

This records the candidate identity only. It does **not** by itself authorize a
multi-gigabyte device download. Download remains a separate explicit device
mutation gate.

## C4-2: immutable model identity record

Before first acceptance run, record at minimum:

```text
source repository:
source revision / commit:
license:
filename:
quantization:
byte size:
SHA-256:
llama.cpp source commit: 0021a77de0a8966059dc94548fb3b96654e0bb12
on-device llama-server SHA-256: 94f9aa667e042be00f8270cc8ae384db0dcf1587b9cac45cc22ce8c85704d594
```

Download to a `.part` path first, verify byte size and SHA-256, and rename to
the final model path only after both checks pass. Any mismatch is a hard stop.

## C4-3: direct llama-server proof

With the existing accepted llama-server binary, launch the exact candidate on
`127.0.0.1` only and prove:

- `/health` returns a real healthy response;
- one non-stream chat completion returns model-generated text;
- input-token counting succeeds;
- the reported backend model identity is the configured real local identity;
- no external network dependency is required after model download.

Capture launch time, prompt-processing time and generation rate as device
fitness evidence; these are observations, not hard-coded compatibility
assumptions.

## C4-4: real gemini-local managed-lifecycle proof

Configure the accepted managed launcher with exact absolute paths and SHA-256
pins for the existing llama-server binary and selected GGUF. Then prove on the
real device:

1. backend initially stopped;
2. ordinary `gemini-local` prompt auto-starts it;
3. prompt exits 0 with real local output;
4. `gemini-local status` reports managed-running, healthy, and
   `Owned process verified: yes`;
5. a second ordinary prompt reuses the same managed PID;
6. `gemini-local stop` terminates only the verified owned process;
7. `gemini-local restart` creates a new verified managed PID;
8. another real prompt succeeds after restart;
9. normal Gemini remains version 0.55.1;
10. no hosted fallback occurs anywhere in the sequence.

## C4-5: practical model fitness gate

The final model is accepted only if it is useful on this phone, not merely
loadable. At minimum run several representative text tasks, including:

- concise instruction following;
- code explanation or generation;
- a longer reasoning/writing request.

Record wall-clock behavior, prompt ingestion, generation speed, crashes,
timeouts and any swap pressure or Android process-kill behavior observed.
A technically loadable model that makes the phone unusable is not the final
selection.

## C4-6: repo acceptance

If the same exact model bytes pass C4-2 through C4-5:

- update the C4 documentation with the exact immutable model identity and
  actual device evidence;
- rerun affected focused tests plus the complete bridge suite;
- confirm `vendor/phase-b/*` and `PROVENANCE.json` remain unchanged;
- create a permanent acceptance ref for the exact executable/device-tested
  tree;
- if documentation-only reconciliation follows, create a separate final-docs
  ref and explicitly distinguish it from the executable/device-tested SHA;
- close the C4 PR unmerged by design unless a separate integration decision is
  explicitly authorized.

## Explicitly deferred beyond C4

C4 does not add interactive Gemini mode, slash commands, local tool/function
execution, embeddings, multimodal routing, automatic model downloads, Android
boot persistence, or arbitrary caller Gemini argv forwarding.
