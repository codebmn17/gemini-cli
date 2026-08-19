# Running gemini-local on Termux

This document records the **completed** Android/Termux acceptance of `gemini-local` through Phase C3, including real GGUF inference and managed llama-server startup/reuse/ownership verification.

Final executable/test acceptance head:

```text
a51e04d24091b2a17c27279ea14ca1f33025d686
```

Permanent acceptance ref:

```text
accepted/gemini-local-c3-device-lifecycle-v1
```

The earlier skeleton/install-only acceptance remains preserved separately at `a1b59aea2b70a5699956b4fe66b435d4a8c320a0` and should not be confused with the final local-inference lifecycle acceptance.

## 1. Read-only device inspection

Inspect first. Do not install or update packages just to make validation proceed.

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
command -v clang || true
clang --version 2>/dev/null || true
command -v cmake || true
cmake --version 2>/dev/null || true
command -v make || true
command -v llama-server || true
command -v ollama || true
ollama --version 2>/dev/null || true
```

The accepted device already had its required build/runtime tools. No `pkg install`, `pkg update`, or `pkg upgrade` was needed for the accepted run.

If a future device is missing a prerequisite, stop and get separate authorization before any package-manager mutation.

## 2. Check out an exact reviewed SHA

Never install from a movable feature branch during acceptance. Supply the exact reviewed commit out of band and use a detached checkout.

```sh
TRANSPORT_SHA='<EXACT_REVIEWED_SHA>'

cd ~
if [ ! -d gemini-local-validation/.git ]; then
  git clone --no-checkout https://github.com/codebmn17/gemini-cli.git gemini-local-validation
fi
cd gemini-local-validation
git fetch origin "$TRANSPORT_SHA"
git checkout --detach "$TRANSPORT_SHA"
ACTUAL_SHA="$(git rev-parse HEAD)"
printf 'expected transport SHA: %s\n' "$TRANSPORT_SHA"
printf 'actual transport SHA:   %s\n' "$ACTUAL_SHA"
[ "$ACTUAL_SHA" = "$TRANSPORT_SHA" ] || {
  echo 'STOP: exact SHA mismatch.' >&2
  exit 3
}

cd experimental/gemini-local-bridge
```

For the final accepted executable/test state, `TRANSPORT_SHA` was:

```text
a51e04d24091b2a17c27279ea14ca1f33025d686
```

## 3. Install the bridge

```sh
bash install-gemini-local.sh
hash -r
```

The installer writes only below:

```text
~/.local/bin/gemini-local
~/.local/share/gemini-local-bridge/
~/.config/gemini-local-bridge/
```

It does not replace `/data/data/com.termux/files/usr/bin/gemini`, does not edit the global `@google/gemini-cli` package, and does not modify an existing Ollama install.

## 4. Configure the pinned Gemini host

Example accepted protocol/identity config:

```json
{
  "schemaVersion": 1,
  "backend": "llama.cpp",
  "backendOrigin": "http://127.0.0.1:8090",
  "backendModel": "qwen-test-backend",
  "clientModel": "local-test-client",
  "geminiRoot": "/data/data/com.termux/files/usr/lib/node_modules/@google/gemini-cli"
}
```

Write it to:

```text
~/.config/gemini-local-bridge/llama-cpp-adapter.json
```

The accepted host package identity was:

```text
@google/gemini-cli 0.55.1
```

## 5. Build the pinned llama-server

Accepted llama.cpp source commit:

```text
0021a77de0a8966059dc94548fb3b96654e0bb12
```

Reproducible build:

```sh
cd ~
git clone --filter=blob:none https://github.com/ggml-org/llama.cpp.git llama-cpp-c3
cd llama-cpp-c3
git fetch origin 0021a77de0a8966059dc94548fb3b96654e0bb12
git checkout --detach 0021a77de0a8966059dc94548fb3b96654e0bb12
git rev-parse HEAD

cmake -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build --config Release --target llama-server
./build/bin/llama-server --version
sha256sum ./build/bin/llama-server
```

Accepted Android/aarch64 result:

```text
version: 0.1.1-dev (build 10479, commit 0021a77de)
SHA-256: 94f9aa667e042be00f8270cc8ae384db0dcf1587b9cac45cc22ce8c85704d594
```

## 6. Smoke-test GGUF

The accepted smoke model was deliberately tiny because its job was to prove plumbing, not final model quality:

```text
Qwen/Qwen2.5-0.5B-Instruct-GGUF
qwen2.5-0.5b-instruct-q4_k_m.gguf
491400032 bytes
SHA-256: 74a4da8c9fdbcd15bd1f6d01d621410d31c6fc00986f5eb687824e7b93d7a9db
```

Model download was separately authorized. Do not silently substitute another model or hash in an acceptance run.

## 7. Managed backend launch config

Final `gemini-local` can lazily start llama-server itself. The exact local binary and GGUF must be SHA-256 pinned.

Example accepted config:

```json
{
  "schemaVersion": 1,
  "serverPath": "/data/data/com.termux/files/home/llama-cpp-c3/build/bin/llama-server",
  "serverSha256": "94f9aa667e042be00f8270cc8ae384db0dcf1587b9cac45cc22ce8c85704d594",
  "modelPath": "/data/data/com.termux/files/home/c3-models/qwen2.5-0.5b-instruct-q4_k_m.gguf",
  "modelSha256": "74a4da8c9fdbcd15bd1f6d01d621410d31c6fc00986f5eb687824e7b93d7a9db"
}
```

Write it to:

```text
~/.config/gemini-local-bridge/llama-cpp-launch.json
```

and set mode `0600`.

No model or server is downloaded automatically. This config only authorizes execution of the already-present, hash-matching local artifacts.

## 8. Doctor and status

`doctor` remains filesystem-only:

```sh
gemini-local doctor
```

It verifies installation/provenance/config state without probing backend health or spawning a model.

`status` adds live loopback backend/ownership status:

```sh
gemini-local status
```

A stopped backend should report stopped/not healthy. A managed running backend should report:

```text
Backend status: managed-running
Healthy: yes
Managed: yes
Owned process verified: yes
```

## 9. Automatic startup proof

First prove the configured backend is down, then run an ordinary prompt:

```sh
if curl --silent --fail --max-time 1 http://127.0.0.1:8090/health >/dev/null 2>&1; then
  echo 'STOP: backend is already running' >&2
  exit 5
fi

gemini-local \
  "Reply with the exact token FINAL_LOCAL_AUTOSTART_OK and nothing else."
```

Accepted result:

```text
FINAL_LOCAL_AUTOSTART_OK
```

with exit 0. The first ordinary prompt automatically started the hash-pinned llama-server/model; a subsequent `/health` returned `{"status":"ok"}`.

## 10. Android ownership verification

The first managed-autostart device run exposed a real platform-specific issue: Termux Node reports:

```text
process.platform === "android"
```

while the ownership verifier originally enabled `/proc` verification only for `linux`. `/proc/<pid>/exe` on the device correctly resolved to the exact configured llama-server, so the verifier was corrected to support both Linux and Android.

Final accepted Android ownership evidence:

```text
Owned process verified: yes
```

The correction changed only `lib/managed-backend.mjs` and its focused device regression before the final executable acceptance head `a51e04d24091b2a17c27279ea14ca1f33025d686` was accepted.

## 11. Stop, restart and reuse

The managed lifecycle is intentionally conservative: only a process whose recorded state and `/proc` identity are verified may receive destructive stop/restart signals.

```sh
gemini-local stop
```

Verify the old PID is gone and port 8090 is down, then:

```sh
gemini-local restart
```

Verify a new PID is recorded, backend health is OK and ownership is verified.

Finally run another ordinary prompt:

```sh
gemini-local \
  "Reply with the exact token FINAL_LOCAL_REUSE_OK and nothing else."
```

Accepted result:

```text
FINAL_LOCAL_REUSE_OK
```

with exit 0. The managed PID was `13828` both before and after this reuse prompt, proving the already-running backend was reused rather than replaced. Final status was:

```text
Backend status: managed-running
Healthy: yes
Managed: yes
PID: 13828
Owned process verified: yes
```

The previous managed PID before the final stop/restart sequence was `6758`, so the restart produced a new process before the reuse proof.

## 12. Test evidence

Immediately before the final Android-only ownership correction, exact hardened head `302f2705984187157c5834fdcd2c209ec7ea2cab` passed on-device:

```text
focused device-finalization: 6/6
full default suite: 159 pass, 0 fail, 1 skip
real pinned Gemini suite: 160/160, 0 fail, 0 skip
.mjs syntax: 33/33
installer bash -n: pass
uninstaller bash -n: pass
Phase-B/provenance diff against accepted device proof: empty
```

The final Android ownership correction then passed its focused regression, syntax check, reinstall, live status and ownership gate on the actual Android device:

```text
focused=0 syntax=0 install=0 status=0 ownership=0
```

and the final managed lifecycle behavior in sections 9-11 passed on the corrected executable head.

## 13. Preserved boundaries

Throughout C3 device acceptance:

- normal Gemini remained `/data/data/com.termux/files/usr/bin/gemini` version `0.55.1`;
- existing Ollama was not replaced or reconfigured;
- `vendor/phase-b/*` remained the accepted immutable ten-file payload;
- `PROVENANCE.json` remained unchanged;
- no hosted-Gemini fallback was enabled;
- backend binding stayed literal `127.0.0.1`;
- the local model was never branded or renamed as Gemini;
- `main` and `product/gemini-local-v1` were not merged or moved.

## 14. Deferred scope

This acceptance does **not** claim:

- interactive Gemini CLI mode;
- slash-command support;
- tool/function execution through the local model;
- embeddings or multi-model routing UX;
- automatic GGUF downloads or Termux package installation;
- Android-boot daemon behavior;
- final long-term model selection;
- equivalence across untested Android versions, devices or architectures.

The Qwen 0.5B GGUF is only the accepted smoke model. A later model-selection phase can replace it by updating the explicit backend identity/path/hash configuration and validating that model separately.
