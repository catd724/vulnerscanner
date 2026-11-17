#!/usr/bin/env bash
#
# Automated Linux Vulnerability Scanner - Central Entry Point
#
# Usage:
#   ./vulnscan.sh                 # interactive menu
#   ./vulnscan.sh --services      # check services status
#   ./vulnscan.sh --docker        # check Docker status and image vulnerabilities
#   ./vulnscan.sh --pm2           # check PM2 status
#   ./vulnscan.sh --library-vulns # check installed libraries for vulnerabilities
#   ./vulnscan.sh --full          # run all checks
#   ./vulnscan.sh --help          # show this help
#
# Remote execution:
#   bash <(curl -sL https://raw.githubusercontent.com/<org>/<repo>/main/scripts/vulnscan.sh) --full
#

set -euo pipefail

# Resolve the directory that holds this script. When run via process
# substitution (bash <(curl ...)) BASH_SOURCE points to /dev/fd/NN, so local
# lib files are unavailable; in that case we fetch them from the remote repo.
REMOTE_BASE="${VULNSCAN_REPO:-https://raw.githubusercontent.com/catd724/vulnerscanner/refs/heads/main/scripts}"

if [[ -n "${BASH_SOURCE[0]:-}" ]]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd 2>/dev/null || true)"
else
  SCRIPT_DIR=""
fi

# If lib files are missing (process substitution or incomplete copy), download them.
if [[ -z "$SCRIPT_DIR" ]] || [[ ! -f "$SCRIPT_DIR/lib/common.sh" ]]; then
  TEMP_DIR="$(mktemp -d /tmp/vulnscan-libs.XXXXXX)"
  trap 'rm -rf "$TEMP_DIR"' EXIT
  SCRIPT_DIR="$TEMP_DIR"

  for lib in common.sh osv_api.sh package_enum.sh service_check.sh docker_check.sh pm2_check.sh library_check.sh; do
    if ! curl -fsSL --max-time 20 "$REMOTE_BASE/lib/$lib" -o "$SCRIPT_DIR/$lib" 2>/dev/null; then
      echo "{\"ok\": false, \"error\": \"Failed to download required module: $lib from $REMOTE_BASE/lib/$lib\"}" >&2
      exit 1
    fi
  done
fi

# Source helpers.
# shellcheck source=lib/common.sh
. "$SCRIPT_DIR/common.sh"
# shellcheck source=lib/osv_api.sh
. "$SCRIPT_DIR/osv_api.sh"
# shellcheck source=lib/package_enum.sh
. "$SCRIPT_DIR/package_enum.sh"
# shellcheck source=lib/service_check.sh
. "$SCRIPT_DIR/service_check.sh"
# shellcheck source=lib/docker_check.sh
. "$SCRIPT_DIR/docker_check.sh"
# shellcheck source=lib/pm2_check.sh
. "$SCRIPT_DIR/pm2_check.sh"
# shellcheck source=lib/library_check.sh
. "$SCRIPT_DIR/library_check.sh"

print_help() {
  cat <<'EOF'
Automated Linux Vulnerability Scanner

Usage: vulnscan.sh [OPTION]

Options:
  --services        Check systemd services status
  --docker          Check Docker daemon, containers, and image vulnerabilities
  --pm2             Check PM2 process status
  --library-vulns   Check installed libraries/packages for known CVEs
  --full            Run all checks
  --help            Show this help message

With no options, an interactive menu is shown.

Remote execution:
  bash <(curl -sL https://raw.githubusercontent.com/<org>/<repo>/main/scripts/vulnscan.sh) --full
EOF
}

# Check that jq is available.
if ! command -v jq >/dev/null 2>&1; then
  echo '{"ok": false, "error": "jq is required but not installed"}' >&2
  exit 1
fi

# Run a single check by name and print its JSON result.
run_check() {
  local check="$1"
  case "$check" in
    services) check_services ;;
    docker) check_docker ;;
    pm2) check_pm2 ;;
    library_vulns) check_libraries ;;
    *) error_result "unknown" "Unknown check: $check" ;;
  esac
}

run_full_scan() {
  local tmpdir
  tmpdir=$(mktemp -d /tmp/vulnscan-full.XXXXXX)

  # Run independent checks in parallel to keep the full scan fast.
  check_services > "$tmpdir/services.json" &
  check_docker > "$tmpdir/docker.json" &
  check_pm2 > "$tmpdir/pm2.json" &
  check_libraries > "$tmpdir/libraries.json" &
  wait

  local result
  result=$(jq -n \
    --arg timestamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg host "$(hostname 2>/dev/null || echo unknown)" \
    --slurpfile services "$tmpdir/services.json" \
    --slurpfile docker "$tmpdir/docker.json" \
    --slurpfile pm2 "$tmpdir/pm2.json" \
    --slurpfile libraries "$tmpdir/libraries.json" \
    '{
      scan_type: "full",
      timestamp: $timestamp,
      host: $host,
      ok: true,
      results: {services: $services[0], docker: $docker[0], pm2: $pm2[0], libraries: $libraries[0]}
    }')

  rm -rf "$tmpdir"
  echo "$result"
}

show_menu() {
  while true; do
    echo
    echo "=== Automated Linux Vulnerability Scanner ==="
    echo "1) Check services status"
    echo "2) Check Docker status"
    echo "3) Check PM2 status"
    echo "4) Check libraries vulnerability status"
    echo "5) Check Docker images update status / vulnerabilities"
    echo "6) Run full scan"
    echo "7) Exit"
    echo -n "Select option: "
    read -r choice
    echo

    case "$choice" in
      1) run_check services ;;
      2) run_check docker ;;
      3) run_check pm2 ;;
      4) run_check library_vulns ;;
      5) run_check docker ;;
      6) run_full_scan ;;
      7) exit 0 ;;
      *) echo '{"ok": false, "error": "Invalid option"}' ;;
    esac
  done
}

# Parse CLI flags.
if [[ $# -eq 0 ]]; then
  show_menu
else
  case "$1" in
    --services) run_check services ;;
    --docker) run_check docker ;;
    --pm2) run_check pm2 ;;
    --library-vulns) run_check library_vulns ;;
    --full) run_full_scan ;;
    --help|-h) print_help ;;
    *)
      echo '{"ok": false, "error": "Unknown option: '"$1"'"}' >&2
      print_help >&2
      exit 1
      ;;
  esac
fi
