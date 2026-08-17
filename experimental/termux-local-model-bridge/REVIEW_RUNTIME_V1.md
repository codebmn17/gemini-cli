# Phase B Runtime Materializer — Review Handoff

This note is review evidence for the stacked Phase B runtime-materializer slice.
It is not production documentation and does not authorize launching Gemini.

## Stack

- Base auth-routing head: `f24eca6fcfb6c76d8ce3387e2d915e5cb64e31f0`
- Runtime branch: `review/termux-local-model-runtime-v1`
- Pinned Gemini CLI: `0.55.1` @ `41327e407da58aa01c409ef6685b7b5d379f295e`

## Scope

The runtime slice materializes the filesystem/environment requirements already
accepted in the auth-routing contract. It does not spawn Gemini, invoke a model,
open a network connection, use a real credential, or mutate the user's Gemini
home/workspace.

The runtime creates a fresh private temporary root containing:

- an isolated `GEMINI_CLI_HOME`;
- a fresh empty working directory;
- a private isolated system-settings file;
- a child environment built in reviewed copy → mask → safe-set → runtime-binding
  order.

The runtime keeps the settings file descriptor open for the lifetime of the
runtime and exposes `verifyPhaseBRuntime()` so the later launcher can re-check
filesystem identity/content immediately before any future spawn.

## Authoring defects found and fixed before handoff

1. The first draft treated `process.env` as a plain Object-prototype object.
   Real Node `process.env` does not satisfy that assumption, so default
   materialization would have failed. The environment validator now accepts an
   environment-like object containing only string/undefined values, and a
   regression test exercises the real `process.env` default.
2. The first runtime validator checked contract shape but did not independently
   re-pin the exact safe child-environment literals. A tampered contract could
   therefore have substituted an external model base URL or non-placeholder API
   key. The validator now requires the exact reviewed mask set, exact safe
   literals, and exact runtime bindings. Regression tests cover endpoint/key/
   mask/binding tampering.
3. The first integrity check relied on path `dev`/`ino` identity. A delete and
   immediate recreate of the settings file demonstrated inode reuse on the
   authoring filesystem, so that check was insufficient. The runtime now keeps
   the original settings descriptor open and compares the live path against the
   held descriptor's `fstat()` identity; this prevents inode recycling from
   defeating the replacement check during the runtime lifetime.

## Author validation

The exact current runtime library and runtime-test blobs were reconstructed and
run locally. The focused runtime suite passed **10/10** with zero failures,
skips, or cancellations, and `node --check` passed for both new `.mjs` files.

The inherited recorder/preflight/auth-routing stack was **not** independently
re-run by the author after this runtime slice. Its last independent accepted
result was Claude's PR #4 review at `f24eca6...`: **58/58**. The reviewer must
rerun the complete stacked suite against the runtime head before acceptance.

## Required adversarial review targets

In addition to normal correctness/testing, independently attack:

- ambient Node/runtime injection inherited from the parent environment,
  especially `NODE_OPTIONS`, `NODE_PATH`, `LD_PRELOAD`, `LD_LIBRARY_PATH`,
  `DYLD_*`, `HOME`, XDG state/config/cache/data variables, TLS/certificate
  overrides, and any other generic process-level variable that can execute
  code, alter module resolution, redirect persistent state, or change network
  trust before Gemini-level isolation applies;
- whether `GEMINI_CLI_HOME` is sufficient for the controlled probe or whether
  the future child must additionally bind generic home/XDG variables;
- symlink/path replacement races for the runtime root, Gemini home, cwd, and
  settings path;
- held-descriptor lifecycle, leaks/exhaustion, cleanup behavior, and failure
  paths;
- permission behavior on Linux/Android/Termux and portability implications;
- `mkdtemp` parent/path assumptions;
- runtime verification immediately before the future spawn;
- malformed/tampered contract objects and environment values;
- any route by which a real credential, external endpoint, real Gemini state,
  non-empty workspace, forwarded argv, or executable/network behavior can
  enter this slice.

Fix only bounded defects belonging to this runtime-materializer slice. Do not
add the Gemini launcher/spawn, real auth/model probes, llama.cpp integration,
tools policy, or unrelated Gemini CLI UX fixes here.
