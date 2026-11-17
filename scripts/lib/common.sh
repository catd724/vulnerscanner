#!/usr/bin/env bash
#
# Common helpers for the vulnerability scanner.
# Sourced by the module scripts; not executed directly.
#

set -euo pipefail

# Detect operating system and package manager.
detect_os() {
  local id="unknown"
  local version_id=""
  local name=""
  local pkg_manager=""
  local ecosystem=""

  if [[ -f /etc/os-release ]]; then
    # shellcheck source=/dev/null
    . /etc/os-release
    id="${ID:-unknown}"
    version_id="${VERSION_ID:-}"
    name="${NAME:-$id}"
  elif command -v lsb_release >/dev/null 2>&1; then
    id=$(lsb_release -si | tr '[:upper:]' '[:lower:]')
    version_id=$(lsb_release -sr)
    name=$(lsb_release -sd)
  fi

  case "$id" in
    debian|ubuntu|linuxmint|pop)
      pkg_manager="dpkg"
      ecosystem="Debian"
      ;;
    alpine)
      pkg_manager="apk"
      ecosystem="Alpine"
      ;;
    fedora|rhel|centos|rocky|almalinux|amzn)
      pkg_manager="rpm"
      ecosystem="Red Hat"
      ;;
    arch|manjaro)
      pkg_manager="pacman"
      ecosystem="Arch Linux"
      ;;
    opensuse*|suse*)
      pkg_manager="rpm"
      ecosystem="openSUSE"
      ;;
    *)
      pkg_manager="unknown"
      ecosystem="Linux"
      ;;
  esac

  jq -n \
    --arg id "$id" \
    --arg version_id "$version_id" \
    --arg name "$name" \
    --arg pkg_manager "$pkg_manager" \
    --arg ecosystem "$ecosystem" \
    '{id: $id, version_id: $version_id, name: $name, pkg_manager: $pkg_manager, ecosystem: $ecosystem}'
}

# Print a JSON scan envelope.
scan_envelope() {
  local scan_type="$1"
  local host
  host=$(hostname 2>/dev/null || echo "unknown")
  jq -n \
    --arg scan_type "$scan_type" \
    --arg timestamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg host "$host" \
    '{scan_type: $scan_type, timestamp: $timestamp, host: $host}'
}

# Merge an envelope with a details object: {"summary": ..., "details": ...}.
merge_result() {
  local envelope="$1"
  local details="$2"
  echo "$envelope" | jq --argjson details "$details" '. + $details'
}

# Output a simple JSON error result.
error_result() {
  local scan_type="$1"
  local message="$2"
  scan_envelope "$scan_type" | jq --arg message "$message" '. + {ok: false, error: $message}'
}

# Wait briefly for terminal output to settle.
pause_for_terminal() {
  sleep 0.1
}
