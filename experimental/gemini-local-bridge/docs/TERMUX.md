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
