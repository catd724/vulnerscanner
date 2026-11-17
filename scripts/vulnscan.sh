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

# Resolve the directory that holds this script so sourced modules work when
# executed remotely via process substitution as well as locally.
if [[ -n "${BASH_SOURCE[0]:-}" ]]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
else
  SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
fi

# Source helpers.
# shellcheck source=lib/common.sh
. "$SCRIPT_DIR/lib/common.sh"
# shellcheck source=lib/osv_api.sh
. "$SCRIPT_DIR/lib/osv_api.sh"
# shellcheck source=lib/package_enum.sh
. "$SCRIPT_DIR/lib/package_enum.sh"
# shellcheck source=lib/service_check.sh
. "$SCRIPT_DIR/lib/service_check.sh"
# shellcheck source=lib/docker_check.sh
. "$SCRIPT_DIR/lib/docker_check.sh"
# shellcheck source=lib/pm2_check.sh
. "$SCRIPT_DIR/lib/pm2_check.sh"
# shellcheck source=lib/library_check.sh
. "$SCRIPT_DIR/lib/library_check.sh"

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
  local services docker pm2 libraries
  services=$(check_services)
  docker=$(check_docker)
  pm2=$(check_pm2)
  libraries=$(check_libraries)

  jq -n \
    --arg timestamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg host "$(hostname 2>/dev/null || echo unknown)" \
    --argjson services "$services" \
    --argjson docker "$docker" \
    --argjson pm2 "$pm2" \
    --argjson libraries "$libraries" \
    '{
      scan_type: "full",
      timestamp: $timestamp,
      host: $host,
      ok: true,
      results: {services: $services, docker: $docker, pm2: $pm2, libraries: $libraries}
    }'
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
