# Running gemini-local on Termux

The current `gemini-local` skeleton/install lifecycle has been validated on a
real Android/Termux device. The exact executable/test tree accepted on-device
was:

`a1b59aea2b70a5699956b4fe66b435d4a8c320a0`

The accepted scope includes installation, integrity/doctor checks,
fail-closed prompt behavior, the complete 56-test suite, default uninstall
with config preservation, reinstall, `--purge`, final reinstall, and
preservation of the existing Gemini CLI. This does **not** claim validation
of future llama.cpp model inference or adapter/process-launch behavior that
is not wired into this skeleton yet. See
[Accepted device evidence and remaining deferred scope](#accepted-device-evidence-and-remaining-deferred-scope)
below.

The commands below remain the reproducible validation procedure for a fresh
or future reviewed transport SHA.

## 1. Read-only environment inspection (do this first, before anything else)

Run exactly this. It only reads state — it installs, updates, or upgrades
nothing, and changes nothing about the device:

```sh
uname -a
printf 'HOME=%s\n' "$HOME"
printf 'PREFIX=%s\n' "$PREFIX"
command -v git || true
git --version 2>/dev/null || true
command -v node || true
node --version 2>/dev/null || true
command -v npm || true
npm --version 2>/dev/null || true
command -v gemini || true
gemini --version 2>/dev/null || true
command -v llama-server || true
command -v llama-cli || true
command -v ollama || true
```

Record the full output. **Do not run `pkg update` / `pkg install` (or any
other install/upgrade command) as part of this validation pass.** This
report is meant to establish what is already on the device before any
change to it is even considered.

If `git`, `node`, or `npm` needed for the next steps is missing: **stop
here** and report exactly which prerequisite is missing. Installing it is a
separate, explicitly authorized step, not something to do automatically as
part of running this validation. Do not install anything just to make
validation proceed, and do not change a device that was already in a known
working state merely to run this check.

Only continue to step 2 once you have confirmed `git` and `node` (with
`node --test` support, i.e. Node 18+) are already present, or their
installation has been separately authorized and completed.

## 2. Get the exact reviewed transport commit onto the device

Do **not** install from a movable branch name. Obtain the exact 40-character
transport SHA from the independent acceptance report/handoff, paste it below,
and check out that commit detached. The placeholder is intentionally not a
valid SHA so an unedited copy-paste cannot proceed accidentally.

```sh
TRANSPORT_SHA='<EXACT_REVIEWED_PR7_SHA>'

cd ~
git clone --no-checkout https://github.com/codebmn17/gemini-cli.git gemini-local-validation
cd gemini-local-validation
git fetch origin "$TRANSPORT_SHA"
git checkout --detach "$TRANSPORT_SHA"
ACTUAL_SHA="$(git rev-parse HEAD)"
printf 'expected transport SHA: %s\n' "$TRANSPORT_SHA"
printf 'actual transport SHA:   %s\n' "$ACTUAL_SHA"
[ "$ACTUAL_SHA" = "$TRANSPORT_SHA" ] || {
  echo 'STOP: checked-out transport SHA does not match the independently accepted SHA.' >&2
  exit 3
}
cd experimental/gemini-local-bridge
```

If `git fetch origin "$TRANSPORT_SHA"` cannot obtain that exact commit,
**stop and report it**. Do not substitute the PR branch, `main`, or another
nearby SHA just to continue.

## 3. Install

```sh
bash install-gemini-local.sh
```

This writes only below the product-owned locations:

- `~/.local/bin/gemini-local`
- `~/.local/share/gemini-local-bridge/`
- `~/.config/gemini-local-bridge/`

The installer treats `HOME` as the trusted boundary and fails closed if an
existing path component beneath it that leads to one of those owned targets
is a symlink or an unexpected filesystem object. It does not touch any
existing `gemini` binary, any globally installed `@google/gemini-cli` npm
package, or any path under Termux's `$PREFIX`.

Promoted files retain their reviewed manifest-declared installed modes:
`0555` for promoted executable launchers and `0444` for promoted
libraries/package metadata. Their containing vendor directories remain
owner-writable so a normal non-root Termux user can rename, reinstall,
clean up staging, and uninstall safely.

## 4. Put the launcher on PATH

The installer does not edit your shell startup file automatically. If
`~/.local/bin` is not already on PATH, add this yourself (once) to
`~/.bashrc` (or your shell's equivalent), then reload it:

```sh
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc
```

## 5. Verify

```sh
command -v gemini-local
command -v gemini
gemini-local version
gemini --version
gemini-local doctor
echo "doctor exit: $?"
```

`doctor` performs filesystem reads and SHA-256 hashing only — no model
inference, no network request. At the current skeleton stage it should report
`installState: installed-ok`, `vendored-artifact-integrity` with zero
failures, and `NOT READY` because no llama.cpp adapter is installed. A
healthy skeleton doctor exits 0.

For a machine-readable report:

```sh
gemini-local doctor --json
```

## 6. Confirm fail-closed behavior

```sh
gemini-local "hello, can you help me write a poem?"
echo "exit code: $?"
```

Expected: no model answer, a non-zero exit, and a message stating that
`gemini-local` never falls back to hosted Gemini and has no local inference
backend installed yet. If this instead appears to contact a network endpoint
or produce model output, stop and report that immediately.

## 7. Run the automated test suite on-device

```sh
npm test

MJS_COUNT=0
while IFS= read -r -d '' f; do
  node --check "$f" || exit 1
  MJS_COUNT=$((MJS_COUNT + 1))
done < <(find . -type f -name '*.mjs' -print0)
echo "mjs files checked: $MJS_COUNT"

bash -n install-gemini-local.sh
bash -n uninstall-gemini-local.sh
```

Report the exact pass/fail counts rather than inferring them from a previous
run.

## 8. Lifecycle validation

Default uninstall must remove the launcher and data directory while
preserving the config directory:

```sh
CONFIG_DIR="$HOME/.config/gemini-local-bridge"
printf 'preserve-me\n' > "$CONFIG_DIR/device-validation-marker.txt"

bash uninstall-gemini-local.sh
hash -r
command -v gemini-local || true
test ! -e "$HOME/.local/share/gemini-local-bridge"
cat "$CONFIG_DIR/device-validation-marker.txt"
command -v gemini
gemini --version
```

Reinstall, verify `doctor` again, then test purge:

```sh
bash install-gemini-local.sh
gemini-local doctor

bash uninstall-gemini-local.sh --purge
hash -r
command -v gemini-local || true
test ! -e "$HOME/.local/bin/gemini-local"
test ! -e "$HOME/.local/share/gemini-local-bridge"
test ! -e "$HOME/.config/gemini-local-bridge"
command -v gemini
gemini --version
```

Finally reinstall so the device is left in the intended installed skeleton
state, rerun `doctor`, reconfirm the exact detached HEAD, and verify that no
`.stage.*` directory remains.

## Accepted device evidence and remaining deferred scope

The exact executable/test tree
`a1b59aea2b70a5699956b4fe66b435d4a8c320a0` was validated on a real
Android 15 / aarch64 Termux device with:

- Git 2.55.0
- Node v26.4.0
- npm 11.19.0
- existing Gemini CLI 0.55.1 at Termux `$PREFIX/bin/gemini`

The first device candidate (`c62673212f716732a87a3e54b7f4daa760c3790e`)
exposed a real non-root filesystem defect: staged vendor directories were
changed to mode `0555` before rename/cleanup, causing `Permission denied`.
The correction removed directory lock-down while preserving promoted file
modes and added a dedicated Termux directory-permission regression.

At the corrected exact tree `a1b59aea...`, real-device evidence was:

- targeted non-root Termux directory-permission regression: **1/1 passed**
- real installer: **PASS**
- no stale `.stage.*` directories after successful install
- `gemini-local doctor`: `installed-ok`, exact 10-file provenance set,
  vendored integrity 10/10 with zero failures, expected adapter-absent
  `NOT READY`, exit **0**
- arbitrary prompt: no model answer, explicit no-hosted-fallback refusal,
  exit **3**
- complete current-head suite: **56/56 passed**, 0 failed/cancelled/skipped/todo
- all **20/20** applicable `.mjs` files passed `node --check`
- installer and uninstaller both passed `bash -n`
- default uninstall: exit 0, launcher/data removed, config marker
  `preserve-me` survived, normal Gemini remained 0.55.1
- reinstall after default uninstall: **PASS**, healthy doctor restored
- purge: exit 0, launcher/data/config removed, `gemini-local` no longer
  resolved after `hash -r`, normal Gemini remained 0.55.1
- final reinstall: healthy `installed-ok` doctor, exit 0, normal Gemini still
  0.55.1, exact HEAD still `a1b59aea...`, no stale `.stage.*` directory

**Accepted for the current skeleton/install lifecycle on this tested Termux
device.**

After this device run, documentation-only reconciliation updated this file
and the bundle README. The final transport/documentation head therefore
advances beyond `a1b59aea...`; the acceptance report must distinguish that
final transport SHA from the exact executable/test tree above. No executable,
test, installer, provenance, or vendored artifact was changed by that
reconciliation.

Still deferred / not claimed by this acceptance:

- installation or configuration of a llama.cpp adapter
- actual local model inference, streaming, token counting, embeddings, or
  model traffic
- future adapter/launcher process-spawn behavior that is not wired into this
  skeleton
- behavior on other Android/Termux versions, architectures, shells, or
  device filesystems not represented by this validation device

Those deferred capabilities require their own exact-SHA implementation and
real-device validation before they may inherit a Termux acceptance claim.

## C3 device-validation plan (NOT YET EXECUTED)

This section is a **plan only**. None of it has been run on the device. It
exists so the eventual device session has an exact, reviewed procedure to
follow rather than improvising one live. Phase C3 (real llama.cpp + a real
GGUF, proven end to end against the real pinned Gemini CLI) has been proven
on a Linux host only — see this bundle's README for that host evidence. This
plan is what turns that host proof into a device acceptance claim; until it
is actually run and its results recorded, no such claim exists.

### C3-0. Read-only device inspection (run this first; changes nothing)

```sh
uname -m
uname -a
printf 'HOME=%s\n' "$HOME"
printf 'PREFIX=%s\n' "$PREFIX"
df -h "$HOME" 2>/dev/null || df -h "$PREFIX"
free -h 2>/dev/null || cat /proc/meminfo 2>/dev/null | head -3

command -v git || true
git --version 2>/dev/null || true
command -v node || true
node --version 2>/dev/null || true
command -v npm || true
npm --version 2>/dev/null || true
command -v gemini || true
gemini --version 2>/dev/null || true
command -v gemini-local || true
gemini-local doctor 2>/dev/null || true

command -v clang || true
clang --version 2>/dev/null || true
command -v cc || true
command -v cmake || true
cmake --version 2>/dev/null || true
command -v make || true
command -v ninja || true
ninja --version 2>/dev/null || true

command -v llama-server || true
command -v llama-cli || true
command -v ollama || true
ollama --version 2>/dev/null || true
```

Record the full output before anything else. This establishes exactly what
is already present — a Node/npm/git/`gemini` toolchain is expected to
already be there from the accepted skeleton validation above, but that must
be **re-confirmed on this run**, never assumed from the earlier report.
**Do not run `pkg update`, `pkg install`, `pkg upgrade`, or any other
package-manager mutation as part of this step or to make this step
possible.** This is read-only.

### C3-1. Determine what (if anything) needs installing

Building `llama-server` needs a C/C++ toolchain and CMake at minimum (a
generator such as `make` or `ninja`; Termux's `cmake` package pulls in a
usable generator). Only if C3-0 shows any of `clang`/`cc`, `cmake`, or a
generator (`make`/`ninja`) missing, the candidate Termux packages are:

```text
pkg install clang cmake make git
```

**REQUIRES USER AUTHORIZATION BEFORE RUNNING.** Do not run this — or any
`pkg install`/`pkg update` — until:

- C3-0's output has actually been seen and reviewed (not assumed), and
- the user has explicitly authorized this exact install list for this
  exact device.

If C3-0 already shows a working toolchain (a real possibility, since Termux
devices used for development often already carry one), **skip this step
entirely** — do not install anything "just in case." Do not substitute a
different package list than what C3-0's gaps actually show.

### C3-2. Build llama-server from the exact pinned commit

Same pinned commit already built and proven on the Linux host in this
bundle's README — do not substitute `master` or any other commit:

```sh
cd ~
git clone --filter=blob:none https://github.com/ggml-org/llama.cpp.git llama-cpp-c3
cd llama-cpp-c3
git fetch origin 0021a77de0a8966059dc94548fb3b96654e0bb12
git checkout 0021a77de0a8966059dc94548fb3b96654e0bb12
git rev-parse HEAD   # must print 0021a77de0a8966059dc94548fb3b96654e0bb12 -- stop if it does not

cmake -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build --config Release --target llama-server
./build/bin/llama-server --version
```

No aarch64/NEON-specific flags are invented here: CMake's default
architecture detection (`GGML_NATIVE`, on by default) is what the Linux
host build also relied on, and the pinned commit's own build system is
authoritative for whatever it auto-detects on-device. If the build fails or
produces a materially different `--version` output than the Linux host's
(`version: 0.1.1-dev (build 10479, commit 0021a77de)`, exact build number
aside), stop and report the exact discrepancy rather than patching around
it.

This clones into `~/llama-cpp-c3` — outside `$PREFIX` and outside any
`gemini-local` install location. It never touches `~/.local/bin`,
`~/.local/share/gemini-local-bridge/`, `~/.config/gemini-local-bridge/`, or
`$PREFIX` itself.

### C3-3. Download the smoke-test GGUF (separately authorized)

Same model already selected and proven on the Linux host:
`Qwen/Qwen2.5-0.5B-Instruct-GGUF`, file `qwen2.5-0.5b-instruct-q4_k_m.gguf`,
Apache-2.0 licensed, **~491.4 MB download, ~468.7 MiB on disk**. Confirm free
storage from C3-0 comfortably covers this (host build + this file is under
1 GB total) before proceeding.

**REQUIRES USER AUTHORIZATION BEFORE RUNNING** — this is a real, sizeable
download over the device's network connection:

```sh
mkdir -p ~/c3-models
cd ~/c3-models
curl -sSL -o qwen2.5-0.5b-instruct-q4_k_m.gguf \
  "https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/qwen2.5-0.5b-instruct-q4_k_m.gguf"
sha256sum qwen2.5-0.5b-instruct-q4_k_m.gguf
```

Expected SHA-256 (from the Linux host download):
`74a4da8c9fdbcd15bd1f6d01d621410d31c6fc00986f5eb687824e7b93d7a9db`. If the
device's hash differs, stop and report it rather than proceeding with a
file that doesn't match what was already verified.

### C3-4. Start the real backend, loopback only

```sh
~/llama-cpp-c3/build/bin/llama-server \
  -m ~/c3-models/qwen2.5-0.5b-instruct-q4_k_m.gguf \
  --host 127.0.0.1 \
  --port 8090 \
  -a qwen-test-backend \
  --no-webui \
  --offline
```

Never `--host 0.0.0.0`. No `--tools`, no `--agent`, no `--mcp-servers-config`
/ `--mcp-servers-json` — all default to disabled/off and must stay that way.

### C3-5. Direct backend sanity checks (same as the host proof)

```sh
curl -sS http://127.0.0.1:8090/health
curl -sS http://127.0.0.1:8090/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"qwen-test-backend","messages":[{"role":"user","content":"Reply with exactly the word: pineapple"}],"max_tokens":20,"stream":false}'
```

Expect `{"status":"ok"}` and a real, non-empty generated response. If either
differs from the host proof's shape, stop before continuing to C3-6.

### C3-6. Real full-chain proof on-device

Write a local config pointing at the on-device pieces (`~/.config/gemini-local-bridge/llama-cpp-adapter.json`):

```json
{
  "schemaVersion": 1,
  "backend": "llama.cpp",
  "backendOrigin": "http://127.0.0.1:8090",
  "backendModel": "qwen-test-backend",
  "clientModel": "local-test-client",
  "geminiRoot": "<path to the existing on-device @google/gemini-cli 0.55.1 install>"
}
```

`geminiRoot` must point at the **existing** on-device pinned Gemini CLI
0.55.1 install already confirmed by C3-0 (`gemini --version`) — do not
install a second copy. Then, with the real backend from C3-4 still running:

```sh
gemini-local "Reply with the exact token C3_LOCAL_REAL_OK and nothing else."
echo "exit code: $?"
```

Do not treat exact-token compliance as the sole success signal if the
device's response differs from the host's — record whatever the model
actually returned. Required, independently checkable evidence: exit 0; a
non-empty response; `gemini-local doctor`/the response itself never
mentions a Gemini-branded model name for the backend; the real backend log
(if verbose logging is enabled) shows `backendModel`, never `clientModel`;
no leftover `gemini-local-phase-b-*` directory under the device's temp
directory afterward; the llama-server process from C3-4 still running
undisturbed (it is not restarted or reconfigured by this step).

### C3-7. Cleanup and preservation check

```sh
# Stop the C3 llama-server (Ctrl-C or kill its PID) once done.
command -v gemini
gemini --version
command -v ollama
ollama --version 2>/dev/null || true
gemini-local doctor
```

Confirm: the pre-existing `gemini` binary/version is unchanged, any
pre-existing Ollama install is untouched, no `pkg`-managed file outside the
C3-1 authorized install list was modified, and `gemini-local`'s own install
state (from the accepted skeleton lifecycle) is unaffected. `~/llama-cpp-c3`
and `~/c3-models` are disposable scratch directories the user may remove
once done; they were never referenced by `gemini-local`'s own installed
paths.

### What this plan does not authorize

Running this plan does not itself authorize `pkg install`/`pkg update`
(C3-1), the GGUF download (C3-3), or anything else marked **REQUIRES USER
AUTHORIZATION BEFORE RUNNING** above — those remain separate, explicit
approvals at execution time, not blanket pre-approval from this document
existing. This plan does not claim C3 device acceptance; only an actually
executed run, with recorded real results (not a rerun of the host numbers
above), can.
