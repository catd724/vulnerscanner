#!/usr/bin/env bash
#
# Check installed system libraries/packages for known vulnerabilities via OSV.
#

set -euo pipefail

# Cap packages scanned to keep runtime reasonable.
MAX_PACKAGES=200

check_libraries() {
  local envelope
  envelope=$(scan_envelope "library_vulns")

  local os_info
  os_info=$(detect_os)

  local packages
  packages=$(enumerate_packages)
  local total
  total=$(echo "$packages" | jq 'length')

  if [[ "$total" -eq 0 ]]; then
    merge_result "$envelope" \
      '{"summary": {"total_packages": 0, "vulnerable_packages": 0, "critical": 0, "high": 0, "medium": 0, "low": 0, "unknown": 0}, "details": [], "ok": true, "note": "No packages enumerated"}'
    return 0
  fi

  # Build batch query (limit to MAX_PACKAGES).
  local batch_query
  batch_query=$(echo "$packages" | jq --argjson max "$MAX_PACKAGES" '[limit($max; .[] | {package: {ecosystem: .ecosystem, name: .name}, version: .version})]')

  local batch_result
  batch_result=$(curl -sL --max-time 60 -X POST "https://api.osv.dev/v1/querybatch" \
    -H "Content-Type: application/json" \
    -d "{\"queries\": $batch_query}" 2>/dev/null || echo '{"results": []}')

  if ! echo "$batch_result" | jq -e . >/dev/null 2>&1; then
    merge_result "$envelope" \
      '{"summary": {"total_packages": 0, "vulnerable_packages": 0, "critical": 0, "high": 0, "medium": 0, "low": 0, "unknown": 0}, "details": [], "ok": false, "error": "OSV batch query returned invalid JSON"}'
    return 0
  fi

  # Zip packages with their OSV results.
  local details
  details=$(jq -n \
    --argjson packages "$packages" \
    --argjson results "$batch_result" \
    --argjson max "$MAX_PACKAGES" \
    '[
      range(0; ([($packages | length), $max] | min)) as $i |
      $packages[$i] as $pkg |
      ($results.results[$i].vulns // []) as $vulns |
      {
        name: $pkg.name,
        version: $pkg.version,
        ecosystem: $pkg.ecosystem,
        vulnerability_count: ($vulns | length),
        vulnerabilities: [
          $vulns[] | {
            id: .id,
            summary: (.summary // .details // "No summary"),
            severity: ((.severity // []) | if length > 0 then .[0].score else "UNKNOWN" end),
            aliases: (.aliases // [])
          }
        ]
      }
    ]')

  # Count vulnerable packages and severities.
  local vulnerable critical high medium low unknown
  vulnerable=$(echo "$details" | jq '[.[] | select(.vulnerability_count > 0)] | length')
  critical=$(echo "$details" | jq '[.[].vulnerabilities[]? | select((.severity | type == "number" and . >= 9.0) or (.severity | type == "string" and (. | ascii_downcase) == "critical"))] | length')
  high=$(echo "$details" | jq '[.[].vulnerabilities[]? | select((.severity | type == "number" and . >= 7.0 and . < 9.0) or (.severity | type == "string" and (. | ascii_downcase) == "high"))] | length')
  medium=$(echo "$details" | jq '[.[].vulnerabilities[]? | select((.severity | type == "number" and . >= 4.0 and . < 7.0) or (.severity | type == "string" and (. | ascii_downcase) == "medium"))] | length')
  low=$(echo "$details" | jq '[.[].vulnerabilities[]? | select((.severity | type == "number" and . < 4.0) or (.severity | type == "string" and (. | ascii_downcase) == "low"))] | length')
  unknown=$(echo "$details" | jq '[.[].vulnerabilities[]? | select((.severity | type == "string" and (. | ascii_downcase) == "unknown") or .severity == null)] | length')

  local summary
  summary=$(jq -n \
    --argjson total "$total" \
    --argjson vulnerable "$vulnerable" \
    --argjson critical "$critical" \
    --argjson high "$high" \
    --argjson medium "$medium" \
    --argjson low "$low" \
    --argjson unknown "$unknown" \
    '{total_packages: $total, vulnerable_packages: $vulnerable, critical: $critical, high: $high, medium: $medium, low: $low, unknown: $unknown}')

  merge_result "$envelope" \
    "$(jq -n --argjson summary "$summary" --argjson details "$details" '{ok: true, summary: $summary, details: $details}')"
}
