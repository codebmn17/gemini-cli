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

if [ -z "${HOME:-}" ]; then
  echo "install-gemini-local: HOME is not set; refusing to guess an install location." >&2
  exit 2
fi
if [ "${HOME}" = "/" ]; then
  echo "install-gemini-local: HOME resolves to '/'; refusing to install there." >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

BIN_DIR="${HOME}/.local/bin"
DATA_DIR="${HOME}/.local/share/gemini-local-bridge"
CONFIG_DIR="${HOME}/.config/gemini-local-bridge"
LAUNCHER_PATH="${BIN_DIR}/gemini-local"

echo "install-gemini-local: installing for HOME=${HOME}"

mkdir -p "${BIN_DIR}" "${DATA_DIR}" "${CONFIG_DIR}"

# Replace the promoted payload atomically-ish: stage into a temp dir next to
# the real target, then rename over it, so a failure mid-copy never leaves a
# half-written vendor/lib tree in place.
STAGE_DIR="$(mktemp -d "${DATA_DIR}.stage.XXXXXX")"
trap 'rm -rf "${STAGE_DIR}"' EXIT

cp -R "${SCRIPT_DIR}/lib" "${STAGE_DIR}/lib"
cp -R "${SCRIPT_DIR}/vendor" "${STAGE_DIR}/vendor"
cp "${SCRIPT_DIR}/PROVENANCE.json" "${STAGE_DIR}/PROVENANCE.json"

# Mark the promoted (vendored) artifacts read-only: they are meant to be
# immutable between promotions, verified by `gemini-local doctor` against
# PROVENANCE.json's recorded SHA-256 hashes.
find "${STAGE_DIR}/vendor" -type f -exec chmod 444 {} +
find "${STAGE_DIR}/vendor" -type d -exec chmod 555 {} +
chmod 444 "${STAGE_DIR}/PROVENANCE.json"

rm -rf "${DATA_DIR}/lib" "${DATA_DIR}/vendor" "${DATA_DIR}/PROVENANCE.json"
mv "${STAGE_DIR}/lib" "${DATA_DIR}/lib"
mv "${STAGE_DIR}/vendor" "${DATA_DIR}/vendor"
mv "${STAGE_DIR}/PROVENANCE.json" "${DATA_DIR}/PROVENANCE.json"

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
