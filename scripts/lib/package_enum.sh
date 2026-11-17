#!/usr/bin/env bash
#
# Enumerate installed system packages in a normalized format.
#

set -euo pipefail

# Output JSON array of {name, version, ecosystem} objects.
enumerate_packages() {
  local os_info
  os_info=$(detect_os)
  local pkg_manager
  pkg_manager=$(echo "$os_info" | jq -r '.pkg_manager')
  local ecosystem
  ecosystem=$(echo "$os_info" | jq -r '.ecosystem')

  case "$pkg_manager" in
    dpkg)
      dpkg-query -W -f='${Package}\t${Version}\n' 2>/dev/null | awk -F'\t' -v eco="$ecosystem" '
        NF>=2 {printf "{\"name\":\"%s\",\"version\":\"%s\",\"ecosystem\":\"%s\"}\n", $1, $2, eco}
      ' | jq -s '.'
      ;;
    rpm)
      rpm -qa --queryformat '%{NAME}\t%{VERSION}-%{RELEASE}\n' 2>/dev/null | awk -F'\t' -v eco="$ecosystem" '
        NF>=2 {printf "{\"name\":\"%s\",\"version\":\"%s\",\"ecosystem\":\"%s\"}\n", $1, $2, eco}
      ' | jq -s '.'
      ;;
    apk)
      apk list -I 2>/dev/null | awk -v eco="$ecosystem" '
        {
          full=$1
          name=full
          sub(/-[0-9].*$/, "", name)
          version=full
          sub("^" name "-", "", version)
          printf "{\"name\":\"%s\",\"version\":\"%s\",\"ecosystem\":\"%s\"}\n", name, version, eco
        }
      ' | jq -s '.'
      ;;
    pacman)
      pacman -Q 2>/dev/null | awk -v eco="$ecosystem" '
        {printf "{\"name\":\"%s\",\"version\":\"%s\",\"ecosystem\":\"%s\"}\n", $1, $2, eco}
      ' | jq -s '.'
      ;;
    *)
      echo '[]'
      ;;
  esac
}
