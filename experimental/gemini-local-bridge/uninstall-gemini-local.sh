#!/usr/bin/env bash
# uninstall-gemini-local.sh
#
# Removes the gemini-local bridge for the CURRENT user:
#   always removes: ~/.local/bin/gemini-local, ~/.local/share/gemini-local-bridge/
#   only with --purge: also removes ~/.config/gemini-local-bridge/
#
# Config is kept by default because a future slice may store llama.cpp
# adapter configuration there. Pass --purge to remove it too.
#
# HOME is derived at runtime; no Android/Termux path is hardcoded.
# This script never touches the real `gemini` executable or npm.

set -euo pipefail

require_safe_target() {
  local target="$1"
  local expected_type="$2"
  if [ -L "${target}" ]; then
    echo "uninstall-gemini-local: refusing to proceed — ${target} exists as a symlink" \
      "(-> $(readlink "${target}" 2>/dev/null || echo '?')). Remove or replace it manually, then re-run." >&2
    exit 3
  fi
  if [ -e "${target}" ]; then
    if [ "${expected_type}" = "dir" ] && [ ! -d "${target}" ]; then
      echo "uninstall-gemini-local: refusing to proceed — ${target} exists but is not a directory." >&2
      exit 3
    fi
    if [ "${expected_type}" = "file" ] && [ ! -f "${target}" ]; then
      echo "uninstall-gemini-local: refusing to proceed — ${target} exists but is not a regular file." >&2
      exit 3
    fi
  fi
}

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

LOCAL_DIR="${HOME}/.local"
BIN_DIR="${LOCAL_DIR}/bin"
LOCAL_SHARE_DIR="${LOCAL_DIR}/share"
DATA_DIR="${LOCAL_SHARE_DIR}/gemini-local-bridge"
CONFIG_ROOT="${HOME}/.config"
CONFIG_DIR="${CONFIG_ROOT}/gemini-local-bridge"
LAUNCHER_PATH="${BIN_DIR}/gemini-local"

# Complete preflight happens before the first chmod/rm. This prevents a
# later unsafe DATA_DIR/CONFIG_DIR discovery from leaving a partial uninstall.
preflight_uninstall_paths() {
  require_safe_target "${LOCAL_DIR}" dir
  require_safe_target "${BIN_DIR}" dir
  require_safe_target "${LOCAL_SHARE_DIR}" dir
  require_safe_target "${LAUNCHER_PATH}" file
  require_safe_target "${DATA_DIR}" dir
  if [ "${PURGE}" -eq 1 ]; then
    require_safe_target "${CONFIG_ROOT}" dir
    require_safe_target "${CONFIG_DIR}" dir
  fi
}

preflight_uninstall_paths

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
