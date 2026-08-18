#!/usr/bin/env bash
# uninstall-gemini-local.sh
#
# Removes the gemini-local bridge for the CURRENT user:
#   always removes: ~/.local/bin/gemini-local, ~/.local/share/gemini-local-bridge/
#   only with --purge: also removes ~/.config/gemini-local-bridge/
#
# Config is kept by default (not just the promoted payload) because a
# future slice may store llama.cpp adapter configuration there that the
# user would not want silently destroyed by a routine reinstall/uninstall
# cycle. Pass --purge to remove it too.
#
# HOME is derived at runtime; no Android/Termux path is hardcoded.
# This script never touches the real `gemini` executable, npm, or any path
# outside the three directories above.

set -euo pipefail

PURGE=0
for arg in "$@"; do
  case "${arg}" in
    --purge) PURGE=1 ;;
    *)
      echo "uninstall-gemini-local: unknown argument '${arg}' (only --purge is supported)" >&2
      exit 2
      ;;
  esac
done

if [ -z "${HOME:-}" ]; then
  echo "uninstall-gemini-local: HOME is not set; refusing to guess an install location." >&2
  exit 2
fi
if [ "${HOME}" = "/" ]; then
  echo "uninstall-gemini-local: HOME resolves to '/'; refusing to operate there." >&2
  exit 2
fi

BIN_DIR="${HOME}/.local/bin"
DATA_DIR="${HOME}/.local/share/gemini-local-bridge"
CONFIG_DIR="${HOME}/.config/gemini-local-bridge"
LAUNCHER_PATH="${BIN_DIR}/gemini-local"

if [ -e "${LAUNCHER_PATH}" ]; then
  rm -f "${LAUNCHER_PATH}"
  echo "uninstall-gemini-local: removed ${LAUNCHER_PATH}"
else
  echo "uninstall-gemini-local: ${LAUNCHER_PATH} not present, skipping"
fi

if [ -d "${DATA_DIR}" ]; then
  # Vendored files were installed read-only; chmod back so rm can remove them.
  find "${DATA_DIR}" -type f -exec chmod u+w {} + 2>/dev/null || true
  find "${DATA_DIR}" -type d -exec chmod u+w {} + 2>/dev/null || true
  rm -rf "${DATA_DIR}"
  echo "uninstall-gemini-local: removed ${DATA_DIR}"
else
  echo "uninstall-gemini-local: ${DATA_DIR} not present, skipping"
fi

if [ "${PURGE}" -eq 1 ]; then
  if [ -d "${CONFIG_DIR}" ]; then
    rm -rf "${CONFIG_DIR}"
    echo "uninstall-gemini-local: removed ${CONFIG_DIR} (--purge)"
  else
    echo "uninstall-gemini-local: ${CONFIG_DIR} not present, skipping"
  fi
else
  if [ -d "${CONFIG_DIR}" ]; then
    echo "uninstall-gemini-local: kept ${CONFIG_DIR} (pass --purge to remove it too)"
  fi
fi

echo "uninstall-gemini-local: done. The real 'gemini' executable and the global @google/gemini-cli package were not touched."
