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

  # Zip packages with their OSV results. Use temp files to avoid ARG_MAX
  # limits when passing large JSON arrays as jq arguments.
  local pkg_file result_file
  pkg_file=$(mktemp /tmp/vulnscan-pkgs.XXXXXX)
  result_file=$(mktemp /tmp/vulnscan-osv.XXXXXX)
  echo "$packages" > "$pkg_file"
  echo "$batch_result" > "$result_file"

  local details
  details=$(jq \
    --slurpfile packages "$pkg_file" \
    --slurpfile results "$result_file" \
    --argjson max "$MAX_PACKAGES" \
    '[
      range(0; ([($packages[0] | length), $max] | min)) as $i |
      $packages[0][$i] as $pkg |
      ($results[0].results[$i].vulns // []) as $vulns |
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

  rm -f "$pkg_file" "$result_file"

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

  local detail_file
  detail_file=$(mktemp /tmp/vulnscan-details.XXXXXX)
  echo "$details" > "$detail_file"

  jq --slurpfile details "$detail_file" --argjson summary "$summary" \
    '. + {ok: true, summary: $summary, details: $details[0]}' \
    <<< "$envelope"

  rm -f "$detail_file"
}
