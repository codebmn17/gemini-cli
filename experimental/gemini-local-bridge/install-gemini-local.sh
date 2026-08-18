#!/usr/bin/env bash
# install-gemini-local.sh
#
# Installs the gemini-local bridge skeleton for the CURRENT user into:
#   ~/.local/bin/gemini-local
#   ~/.local/share/gemini-local-bridge/
#   ~/.config/gemini-local-bridge/
#
# HOME is derived at runtime from the environment — this script never
# hardcodes an Android app-sandboxed package data path.
# It works unmodified on Termux, plain Linux, and macOS.
#
# It NEVER touches the real `gemini` executable or the globally installed
# @google/gemini-cli npm package: it does not invoke npm, does not write
# outside the three directories above, and does not search $PATH for an
# existing `gemini` to alter.
#
# Safe to re-run: each run replaces the promoted payload (lib/ + vendor/ +
# PROVENANCE.json) with a fresh copy from this bundle and reinstalls the
# launcher. It never touches ~/.config/gemini-local-bridge/ contents beyond
# creating the directory, so any future llama.cpp adapter config a later
# slice writes there survives a reinstall.

set -euo pipefail

# Fails closed (exit 3) if $1 exists as a symlink (checked first, via -L,
# which also catches a broken symlink) or as anything other than the
# expected type ($2: "dir" or "file"). Absent paths are allowed because the
# installer may create them normally.
require_safe_target() {
  local target="$1"
  local expected_type="$2"
  if [ -L "${target}" ]; then
    echo "install-gemini-local: refusing to proceed — ${target} exists as a symlink" \
      "(-> $(readlink "${target}" 2>/dev/null || echo '?')). Remove or replace it manually, then re-run." >&2
    exit 3
  fi
  if [ -e "${target}" ]; then
    if [ "${expected_type}" = "dir" ] && [ ! -d "${target}" ]; then
      echo "install-gemini-local: refusing to proceed — ${target} exists but is not a directory." >&2
      exit 3
    fi
    if [ "${expected_type}" = "file" ] && [ ! -f "${target}" ]; then
      echo "install-gemini-local: refusing to proceed — ${target} exists but is not a regular file." >&2
      exit 3
    fi
  fi
}

if [ -z "${HOME:-}" ]; then
  echo "install-gemini-local: HOME is not set; refusing to guess an install location." >&2
  exit 2
fi
if [ "${HOME}" = "/" ]; then
  echo "install-gemini-local: HOME resolves to '/'; refusing to install there." >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

LOCAL_DIR="${HOME}/.local"
BIN_DIR="${LOCAL_DIR}/bin"
LOCAL_SHARE_DIR="${LOCAL_DIR}/share"
DATA_DIR="${LOCAL_SHARE_DIR}/gemini-local-bridge"
CONFIG_ROOT="${HOME}/.config"
CONFIG_DIR="${CONFIG_ROOT}/gemini-local-bridge"
LAUNCHER_PATH="${BIN_DIR}/gemini-local"

# Verify every existing component below the trusted HOME boundary before
# writes. Checking only the final target is insufficient because an ancestor
# such as ~/.local or ~/.config could itself redirect the operation.
preflight_install_paths() {
  require_safe_target "${LOCAL_DIR}" dir
  require_safe_target "${BIN_DIR}" dir
  require_safe_target "${LOCAL_SHARE_DIR}" dir
  require_safe_target "${DATA_DIR}" dir
  require_safe_target "${CONFIG_ROOT}" dir
  require_safe_target "${CONFIG_DIR}" dir
  require_safe_target "${LAUNCHER_PATH}" file
  require_safe_target "${DATA_DIR}/lib" dir
  require_safe_target "${DATA_DIR}/vendor" dir
  require_safe_target "${DATA_DIR}/PROVENANCE.json" file
}

echo "install-gemini-local: installing for HOME=${HOME}"

preflight_install_paths
mkdir -p "${BIN_DIR}" "${DATA_DIR}" "${CONFIG_DIR}"

# Replace the promoted payload atomically-ish: stage into a temp dir next to
# the real target, then rename over it, so a failure mid-copy never leaves a
# half-written vendor/lib tree in place.
STAGE_DIR="$(mktemp -d "${DATA_DIR}.stage.XXXXXX")"
trap 'rm -rf "${STAGE_DIR}"' EXIT

cp -R "${SCRIPT_DIR}/lib" "${STAGE_DIR}/lib"
cp -R "${SCRIPT_DIR}/vendor" "${STAGE_DIR}/vendor"
cp "${SCRIPT_DIR}/PROVENANCE.json" "${STAGE_DIR}/PROVENANCE.json"

# Mark the promoted (vendored) artifacts read-only, per-file, using each
# file's PROVENANCE.json-recorded installedMode — this preserves the
# accepted commit's executable-bit distinction (bin/*.mjs launchers stay
# 0555; lib/*.mjs and package.json become 0444).
"${GEMINI_LOCAL_NODE:-node}" -e '
const fs = require("node:fs");
const path = require("node:path");
const stageDir = process.argv[1];
const manifest = JSON.parse(fs.readFileSync(path.join(stageDir, "PROVENANCE.json"), "utf8"));
if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
  throw new Error("PROVENANCE.json has no files[] entries");
}
for (const file of manifest.files) {
  if (typeof file.installedMode !== "string" || !/^0[0-7]{3}$/.test(file.installedMode)) {
    throw new Error(`missing/invalid installedMode for ${file.bundlePath}`);
  }
  const target = path.join(stageDir, file.bundlePath);
  fs.chmodSync(target, parseInt(file.installedMode, 8));
}
' "${STAGE_DIR}"
find "${STAGE_DIR}/vendor" -type d -exec chmod 555 {} +
chmod 444 "${STAGE_DIR}/PROVENANCE.json"

# Re-check the complete owned path boundary immediately before the first
# destructive replacement. This narrows (but cannot eliminate) the accepted
# same-user TOCTOU window between verification and pathname-based writes.
preflight_install_paths
rm -rf "${DATA_DIR}/lib" "${DATA_DIR}/vendor" "${DATA_DIR}/PROVENANCE.json"
mv "${STAGE_DIR}/lib" "${DATA_DIR}/lib"
mv "${STAGE_DIR}/vendor" "${DATA_DIR}/vendor"
mv "${STAGE_DIR}/PROVENANCE.json" "${DATA_DIR}/PROVENANCE.json"

# Re-check the ancestor chain again before installing the launcher, so a
# changed ~/.local or ~/.local/bin cannot silently redirect the final copy.
require_safe_target "${LOCAL_DIR}" dir
require_safe_target "${BIN_DIR}" dir
require_safe_target "${LAUNCHER_PATH}" file
cp "${SCRIPT_DIR}/bin/gemini-local" "${LAUNCHER_PATH}"
chmod 755 "${LAUNCHER_PATH}"

echo "install-gemini-local: installed launcher -> ${LAUNCHER_PATH}"
echo "install-gemini-local: installed payload  -> ${DATA_DIR}"
echo "install-gemini-local: config directory   -> ${CONFIG_DIR}"
echo ""

case ":${PATH:-}:" in
  *":${BIN_DIR}:"*)
    echo "install-gemini-local: ${BIN_DIR} is already on PATH."
    ;;
  *)
    echo "install-gemini-local: ${BIN_DIR} is NOT currently on PATH."
    echo "This installer does not modify your shell startup files automatically."
    echo "Add this line to your shell rc file yourself (e.g. ~/.bashrc), then reload it:"
    echo ""
    echo "  export PATH=\"\$HOME/.local/bin:\$PATH\""
    echo ""
    ;;
esac

echo "Next: run 'gemini-local doctor' (or '${LAUNCHER_PATH} doctor' before reloading PATH)."
