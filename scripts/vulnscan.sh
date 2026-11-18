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

  echo "[vulnscan] downloading scanner modules from $REMOTE_BASE ..." >&2
  libs=(common.sh osv_api.sh package_enum.sh service_check.sh docker_check.sh pm2_check.sh library_check.sh)
  pids=()
  for lib in "${libs[@]}"; do
    (
      if ! curl -fsSL --max-time 15 "$REMOTE_BASE/lib/$lib" -o "$SCRIPT_DIR/$lib" 2>/dev/null; then
        echo "{\"ok\": false, \"error\": \"Failed to download required module: $lib from $REMOTE_BASE/lib/$lib\"}" >&2
        exit 1
      fi
    ) &
    pids+=($!)
  done

  for pid in "${pids[@]}"; do
    if ! wait "$pid"; then
      exit 1
    fi
  done
  echo "[vulnscan] modules ready" >&2
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

OUTPUT_JSON=0

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
  --json            Output raw JSON instead of human-readable summary
  --help            Show this help message

With no options, an interactive menu is shown.

Remote execution:
  bash <(curl -sL https://raw.githubusercontent.com/<org>/<repo>/main/scripts/vulnscan.sh) --full
EOF
}

# Print a human-readable summary from a JSON scan result.
format_human() {
  local result="$1"
  local scan_type
  scan_type=$(echo "$result" | jq -r '.scan_type // "unknown"')
  local host
  host=$(echo "$result" | jq -r '.host // "unknown"')
  local ts
  ts=$(echo "$result" | jq -r '.timestamp // "unknown"')
  local ok
  ok=$(echo "$result" | jq -r '.ok // false')
  local note
  note=$(echo "$result" | jq -r '.note // ""')
  local error
  error=$(echo "$result" | jq -r '.error // ""')

  echo
  echo "=== Vulnerability Scan Report ==="
  echo "Host:     $host"
  echo "Type:     $scan_type"
  echo "Time:     $ts"
  echo "Status:   $([[ "$ok" == "true" ]] && echo OK || echo FAILED)"
  [[ -n "$error" ]] && echo "Error:    $error"
  [[ -n "$note" ]] && echo "Note:     $note"
  echo

  case "$scan_type" in
    library_vulns)
      format_library_vulns "$result"
      ;;
    services)
      format_services "$result"
      ;;
    docker)
      format_docker "$result"
      ;;
    pm2)
      format_pm2 "$result"
      ;;
    full)
      format_full "$result"
      ;;
  esac
  echo
}

format_library_vulns() {
  local result="$1"
  local summary
  summary=$(echo "$result" | jq -r '.summary // {}')
  local total
  total=$(echo "$summary" | jq -r '.total_packages // 0')
  local vuln
  vuln=$(echo "$summary" | jq -r '.vulnerable_packages // 0')
  echo "Pending security updates: $vuln package(s) (from $total security repo updates)"
  echo
  local details
  details=$(echo "$result" | jq -c '.details // [] | .[]')
  if [[ -n "$details" ]]; then
    printf "%-30s %-12s %-30s\n" "PACKAGE" "PRIORITY" "UPDATE"
    printf "%-30s %-12s %-30s\n" "------" "--------" "------"
    while IFS= read -r line; do
      local name priority update
      name=$(echo "$line" | jq -r '.name // "-"')
      priority=$(echo "$line" | jq -r '.priority // "-"')
      update=$(echo "$line" | jq -r '.update_available // "-"')
      printf "%-30s %-12s %-30s\n" "$name" "$priority" "$update"
    done <<< "$details"
  fi
}

format_services() {
  local result="$1"
  local summary
  summary=$(echo "$result" | jq -r '.summary // {}')
  local total running failed other
  total=$(echo "$summary" | jq -r '.total // 0')
  running=$(echo "$summary" | jq -r '.running // 0')
  failed=$(echo "$summary" | jq -r '.failed // 0')
  other=$(echo "$summary" | jq -r '.other // 0')
  echo "Services: $total total | $running running | $failed failed | $other other"
  echo
  local details
  details=$(echo "$result" | jq -c '.details // [] | .[]')
  if [[ -n "$details" ]]; then
    local failed_units
    failed_units=$(echo "$result" | jq -r '[.details[]? | select(.state == "failed") | .unit] | join("\n")')
    if [[ -n "$failed_units" ]]; then
      echo "Failed services:"
      echo "$failed_units" | sed 's/^/  - /'
      echo
    fi
    local running_units
    running_units=$(echo "$result" | jq -r '[.details[]? | select(.state == "running") | .unit] | .[0:20] | join("\n")')
    if [[ -n "$running_units" ]]; then
      echo "Running services:"
      echo "$running_units" | sed 's/^/  - /'
      local running_count
      running_count=$(echo "$result" | jq '[.details[]? | select(.state == "running")] | length')
      if [[ "$running_count" -gt 20 ]]; then
        echo "  ... and $((running_count - 20)) more"
      fi
    fi
  fi
}

format_docker() {
  local result="$1"
  local summary
  summary=$(echo "$result" | jq -r '.summary // {}')
  local daemon_up containers images vulnerable
  daemon_up=$(echo "$summary" | jq -r '.daemon_up // false')
  containers=$(echo "$summary" | jq -r '.containers // 0')
  images=$(echo "$summary" | jq -r '.images // 0')
  vulnerable=$(echo "$summary" | jq -r '.vulnerable_images // 0')
  echo "Docker daemon: $([[ "$daemon_up" == "true" ]] && echo up || echo down)"
  echo "Containers: $containers | Images: $images | Vulnerable images: $vulnerable"
  echo
  local image_list
  image_list=$(echo "$result" | jq -c '.details.images // [] | .[]')
  if [[ -n "$image_list" ]]; then
    echo "Images scanned:"
    while IFS= read -r line; do
      local repo tag id vuln_count
      repo=$(echo "$line" | jq -r '.Repository // "-"')
      tag=$(echo "$line" | jq -r '.Tag // "-"')
      id=$(echo "$line" | jq -r '.ID // "-"')
      vuln_count=$(echo "$line" | jq -r '(.vulnerabilities // []) | length')
      printf "  - %s:%s (%s) - %s vulnerabilities\n" "$repo" "$tag" "$id" "$vuln_count"
    done <<< "$image_list"
  fi
}

format_pm2() {
  local result="$1"
  local summary
  summary=$(echo "$result" | jq -r '.summary // {}')
  local total online errored other
  total=$(echo "$summary" | jq -r '.total // 0')
  online=$(echo "$summary" | jq -r '.online // 0')
  errored=$(echo "$summary" | jq -r '.errored // 0')
  other=$(echo "$summary" | jq -r '.other // 0')
  echo "PM2 processes: $total total | $online online | $errored errored | $other other"
  echo
  local details
  details=$(echo "$result" | jq -c '.details // [] | .[]')
  if [[ -n "$details" ]]; then
    printf "%-24s %-10s %-10s\n" "NAME" "STATUS" "RESTARTS"
    printf "%-24s %-10s %-10s\n" "----" "------" "--------"
    while IFS= read -r line; do
      local name status restarts
      name=$(echo "$line" | jq -r '.name // "-"')
      status=$(echo "$line" | jq -r '.status // "-"')
      restarts=$(echo "$line" | jq -r '.restarts // 0')
      printf "%-24s %-10s %-10s\n" "$name" "$status" "$restarts"
    done <<< "$details"
  fi
}

format_full() {
  local result="$1"
  echo "Full scan summary:"
  echo
  local services docker pm2 libraries
  services=$(echo "$result" | jq '.results.services // {}')
  docker=$(echo "$result" | jq '.results.docker // {}')
  pm2=$(echo "$result" | jq '.results.pm2 // {}')
  libraries=$(echo "$result" | jq '.results.libraries // {}')

  if [[ -n "$services" && "$services" != "{}" ]]; then
    echo "--- Services ---"
    format_services "$services"
    echo
  fi
  if [[ -n "$docker" && "$docker" != "{}" ]]; then
    echo "--- Docker ---"
    format_docker "$docker"
    echo
  fi
  if [[ -n "$pm2" && "$pm2" != "{}" ]]; then
    echo "--- PM2 ---"
    format_pm2 "$pm2"
    echo
  fi
  if [[ -n "$libraries" && "$libraries" != "{}" ]]; then
    echo "--- Library vulnerabilities ---"
    format_library_vulns "$libraries"
    echo
  fi
}

# Output a result, either as JSON or human-readable depending on OUTPUT_JSON.
output_result() {
  local result="$1"
  if [[ "$OUTPUT_JSON" == "1" ]]; then
    echo "$result"
  else
    format_human "$result"
  fi
}

# Check that jq is available.
if ! command -v jq >/dev/null 2>&1; then
  echo '{"ok": false, "error": "jq is required but not installed"}' >&2
  exit 1
fi

# Run a single check by name and output its result.
run_check() {
  local check="$1"
  local result
  case "$check" in
    services) result=$(check_services) ;;
    docker) result=$(check_docker) ;;
    pm2) result=$(check_pm2) ;;
    library_vulns) result=$(check_libraries) ;;
    *) result=$(error_result "unknown" "Unknown check: $check") ;;
  esac
  output_result "$result"
}

run_full_scan() {
  local tmpdir
  tmpdir=$(mktemp -d /tmp/vulnscan-full.XXXXXX)

  echo "[full] running services, docker, pm2 and library checks in parallel..." >&2

  # Progress tracking: each job touches a marker file when it finishes.
  local progress_dir
  progress_dir=$(mktemp -d /tmp/vulnscan-progress.XXXXXX)
  touch "$progress_dir/services" "$progress_dir/docker" "$progress_dir/pm2" "$progress_dir/libraries"

  run_check_with_marker() {
    local name="$1"
    local marker="$2"
    local out="$3"
    shift 3
    "$@" > "$out"
    touch "$progress_dir/$marker.done"
  }

  # Run independent checks in parallel to keep the full scan fast.
  run_check_with_marker services services "$tmpdir/services.json" check_services &
  run_check_with_marker docker docker "$tmpdir/docker.json" check_docker &
  run_check_with_marker pm2 pm2 "$tmpdir/pm2.json" check_pm2 &
  run_check_with_marker libraries libraries "$tmpdir/libraries.json" check_libraries &

  # Show a progress bar while the four checks run.
  local total=4
  local completed=0
  while [[ $completed -lt $total ]]; do
    completed=$(find "$progress_dir" -name '*.done' | wc -l)
    local pct=$((completed * 100 / total))
    local filled=$((completed * 30 / total))
    local empty=$((30 - filled))
    local bar=""
    for ((i = 0; i < filled; i++)); do bar+="="; done
    for ((i = 0; i < empty; i++)); do bar+="-"; done
    printf "\r[full] [%s] %3d%% (%s/%s checks complete)" "$bar" "$pct" "$completed" "$total" >&2
    sleep 0.5
  done
  printf "\n" >&2
  wait
  echo "[full] collecting results..." >&2

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

  rm -rf "$tmpdir" "$progress_dir"
  output_result "$result"
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
  exit 0
fi

# Handle global flags first.
for arg in "$@"; do
  case "$arg" in
    --json) OUTPUT_JSON=1 ;;
    --help|-h) print_help; exit 0 ;;
  esac
done

# Run the requested check.
case "$1" in
  --services) run_check services ;;
  --docker) run_check docker ;;
  --pm2) run_check pm2 ;;
  --library-vulns) run_check library_vulns ;;
  --full) run_full_scan ;;
  --json) ;;
  *)
    echo '{"ok": false, "error": "Unknown option: '"$1"'"}' >&2
    print_help >&2
    exit 1
    ;;
esac
