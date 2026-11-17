#!/usr/bin/env bash
#
# Google OSV API helpers.
#

set -euo pipefail

OSV_ENDPOINT="https://api.osv.dev/v1/query"

# Query OSV for vulnerabilities affecting a single package version.
# Args: ecosystem name version
query_osv() {
  local ecosystem="$1"
  local name="$2"
  local version="$3"

  local payload
  payload=$(jq -n \
    --arg ecosystem "$ecosystem" \
    --arg name "$name" \
    --arg version "$version" \
    '{package: {ecosystem: $ecosystem, name: $name}, version: $version}')

  local response
  if ! response=$(curl -sL --max-time 15 -X POST "$OSV_ENDPOINT" \
    -H "Content-Type: application/json" \
    -d "$payload" 2>/dev/null); then
    echo '{"vulns": []}'
    return 0
  fi

  if ! echo "$response" | jq -e . >/dev/null 2>&1; then
    echo '{"vulns": []}'
    return 0
  fi

  echo "$response"
}

# Extract a short severity label from an OSV vuln object.
# Tries CVSS first, then falls back to the database severity field.
severity_of() {
  local vuln="$1"
  echo "$vuln" | jq -r '
    (
      (.severity // [])[] | select(.type == "CVSS_V3") | .score
    ) // (
      (.severity // [])[] | select(.type == "CVSS_V4") | .score
    ) // (
      (.database_specific // {}).severity // "UNKNOWN"
    ) // "UNKNOWN"
  '
}

# Convert a CVSS score or string to a severity label.
severity_label() {
  local sev="$1"
  if [[ "$sev" =~ ^[0-9]+(\.[0-9]+)?$ ]]; then
    local score="$sev"
    if (( $(echo "$score >= 9.0" | bc -l) )); then echo "CRITICAL"; fi
    if (( $(echo "$score >= 7.0 && $score < 9.0" | bc -l) )); then echo "HIGH"; fi
    if (( $(echo "$score >= 4.0 && $score < 7.0" | bc -l) )); then echo "MEDIUM"; fi
    if (( $(echo "$score < 4.0" | bc -l) )); then echo "LOW"; fi
  else
    echo "$sev" | tr '[:lower:]' '[:upper:]'
  fi
}
