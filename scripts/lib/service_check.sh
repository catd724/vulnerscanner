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

  local details="[]"
  local total=0 running=0 failed=0 other=0

  # Prefer JSON output when available (systemd >= 236) for reliable parsing.
  if systemctl list-units --help 2>/dev/null | grep -q -- '--output='; then
    local json_units
    json_units=$(systemctl list-units --type=service --state=running,failed --no-pager --no-legend --output=json 2>/dev/null || true)
    if [[ -n "$json_units" ]] && echo "$json_units" | jq -e . >/dev/null 2>&1; then
      details=$(echo "$json_units" | jq '[.[] | {unit, state: .sub}]')
      total=$(echo "$details" | jq 'length')
      running=$(echo "$details" | jq '[.[] | select(.state == "running")] | length')
      failed=$(echo "$details" | jq '[.[] | select(.state == "failed")] | length')
      other=$((total - running - failed))
    fi
  fi

  # Fallback to text parsing if JSON did not work.
  if [[ "$total" -eq 0 ]]; then
    local units
    units=$(systemctl list-units --type=service --state=running,failed --no-pager --no-legend 2>/dev/null || true)

    while IFS= read -r line; do
      [[ -z "$line" ]] && continue
      local unit state
      # systemctl output: "● service.service loaded active running"
      unit=$(echo "$line" | awk '{print $2}')
      state=$(echo "$line" | awk '{print $5}')
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
  fi

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
