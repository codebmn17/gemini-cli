# Running gemini-local on Termux

This bundle was built and validated on a Linux host only (see
[Host-side validation vs. NOT TESTED](#host-side-validation-vs-not-tested)
below). Nothing in this document has been executed on an actual Termux /
Android device. Run these exact commands on-device and report back what
actually happens — do not treat this document as proof that it works there.

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

## 2. Get this bundle onto the device

```sh
cd ~
git clone https://github.com/codebmn17/gemini-cli.git
cd gemini-cli
git checkout claude/termux-bridge-plan-review-ziqde5
git log -1 --format='%H'   # confirm this matches the commit you were told to expect
cd experimental/gemini-local-bridge
```

## 3. Install

```sh
bash install-gemini-local.sh
```

This writes only to:

- `~/.local/bin/gemini-local`
- `~/.local/share/gemini-local-bridge/`
- `~/.config/gemini-local-bridge/`

It does not touch any existing `gemini` binary, any globally installed
`@google/gemini-cli` npm package, or any path under Termux's `$PREFIX`.

## 4. Put the launcher on PATH

The installer does not edit your shell startup file automatically. Add this
yourself (once) to `~/.bashrc` (or your shell's equivalent), then reload it:

```sh
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc
```

## 5. Verify

```sh
which gemini-local
gemini-local version
gemini-local doctor
```

`doctor` performs filesystem reads and SHA-256 hashing only — no model
inference, no network request. Expect it to report `NOT READY` (no
llama.cpp adapter installed yet) and `vendored-artifact-integrity: OK`. If
integrity is not OK, stop and report the exact failure — do not proceed.

For a machine-readable report:

```sh
gemini-local doctor --json
```

## 6. Confirm fail-closed behavior

```sh
gemini-local "hello, can you help me write a poem?"
echo "exit code: $?"
```

Expected: a non-zero exit and a message stating gemini-local never falls
back to hosted Gemini and has no local inference backend installed yet.
If this instead appears to contact a network endpoint or produce model
output, stop and report that immediately — it would mean the fail-closed
guarantee is broken on-device even though it held on the Linux host.

## 7. (Optional) run the automated test suite on-device

```sh
npm test
```

This exercises the same install/uninstall/doctor/fail-closed tests that
were run on the Linux host, but against Termux's real filesystem and Node
build. Report the exact pass/fail counts.

## 8. Uninstall

```sh
bash uninstall-gemini-local.sh          # keeps ~/.config/gemini-local-bridge/
bash uninstall-gemini-local.sh --purge  # also removes ~/.config/gemini-local-bridge/
```

## Host-side validation vs. NOT TESTED

Validated on the Linux host that built this bundle:

- install/reinstall idempotency, uninstall (default and `--purge`)
- `doctor`/`status`/`version`/`help` output and exit codes
- SHA-256 integrity detection of a tampered vendored file
- fail-closed refusal of an arbitrary prompt (non-zero exit, no hosted-Gemini
  fallback wording)
- `doctor` making no network call (proved by poisoning `fetch`) and a static
  source check that `doctor.mjs`/`run.mjs` never import `node:child_process`,
  `node:net`, `node:http(s)`, or call `fetch`
- the installer/uninstaller never reference `npm`, a hardcoded Termux
  package path, or the real `gemini`/`@google/gemini-cli` install location

Explicitly **NOT TESTED** — only verifiable by running the commands above
on a real device, not assumed to work:

- Android/Termux filesystem semantics (permission bits, symlink handling,
  storage backend behavior under Termux's sandboxed filesystem)
- the actual Termux `$PREFIX` and its interaction (or lack thereof) with
  this installer
- resolution of an actually-installed Gemini CLI (`gemini`) on a real
  Termux `$PATH`
- actual `~/.local/bin` `$PATH` behavior in a real Termux shell session
- actual Termux Node.js/npm behavior (version availability, `node --test`
  support, native module behavior)
- llama.cpp availability/behavior on Termux (no adapter exists yet in this
  slice — `doctor` is expected to report it absent)
- real-device process spawning behavior

Do not report Termux acceptance until each of the above has actually been
run on-device and its real output recorded.
