#!/usr/bin/env bash
#
# Check systemd service status.
#

set -euo pipefail

check_services() {
  local envelope
  envelope=$(scan_envelope "services")

  if ! command -v systemctl >/dev/null 2>&1; then
    merge_result "$envelope" \
      '{"summary": {"total": 0, "running": 0, "failed": 0, "other": 0}, "details": [], "ok": true, "note": "systemctl not found"}'
    return 0
  fi

  local units
  units=$(systemctl list-units --type=service --state=running,failed --no-pager --no-legend 2>/dev/null || true)

  local details="[]"
  local total=0 running=0 failed=0 other=0

  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    local unit state
    unit=$(echo "$line" | awk '{print $1}')
    state=$(echo "$line" | awk '{print $3}')
    [[ -z "$unit" ]] && continue

    total=$((total + 1))
    case "$state" in
      running) running=$((running + 1)) ;;
      failed) failed=$((failed + 1)) ;;
      *) other=$((other + 1)) ;;
    esac

    details=$(echo "$details" | jq --arg unit "$unit" --arg state "$state" \
      '. + [{unit: $unit, state: $state}]')
  done <<< "$units"

  local summary
  summary=$(jq -n \
    --argjson total "$total" \
    --argjson running "$running" \
    --argjson failed "$failed" \
    --argjson other "$other" \
    '{total: $total, running: $running, failed: $failed, other: $other}')

  merge_result "$envelope" \
    "$(jq -n --argjson summary "$summary" --argjson details "$details" '{ok: true, summary: $summary, details: $details}')"
}
