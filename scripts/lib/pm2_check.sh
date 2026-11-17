#!/usr/bin/env bash
#
# Check PM2 process status.
#

set -euo pipefail

check_pm2() {
  local envelope
  envelope=$(scan_envelope "pm2")

  if ! command -v pm2 >/dev/null 2>&1; then
    merge_result "$envelope" \
      '{"summary": {"total": 0, "online": 0, "errored": 0, "other": 0}, "details": [], "ok": true, "note": "pm2 not installed"}'
    return 0
  fi

  local raw
  if ! raw=$(pm2 jlist 2>/dev/null); then
    merge_result "$envelope" \
      '{"summary": {"total": 0, "online": 0, "errored": 0, "other": 0}, "details": [], "ok": false, "error": "pm2 jlist failed"}'
    return 0
  fi

  if ! echo "$raw" | jq -e . >/dev/null 2>&1; then
    merge_result "$envelope" \
      '{"summary": {"total": 0, "online": 0, "errored": 0, "other": 0}, "details": [], "ok": false, "error": "pm2 returned invalid JSON"}'
    return 0
  fi

  local details
  details=$(echo "$raw" | jq '[
    .[] | {
      name: .name,
      status: .pm2_env.status,
      uptime: .pm2_env.pm_uptime,
      restarts: .pm2_env.restart_time,
      cpu: .monit.cpu,
      memory: .monit.memory
    }
  ]')

  local summary
  summary=$(echo "$details" | jq '{
    total: length,
    online: map(select(.status == "online")) | length,
    errored: map(select(.status == "errored")) | length,
    other: map(select(.status != "online" and .status != "errored")) | length
  }')

  merge_result "$envelope" \
    "$(jq -n --argjson summary "$summary" --argjson details "$details" '{ok: true, summary: $summary, details: $details}')"
}
