#!/usr/bin/env bash
#
# Check installed system libraries/packages for known vulnerabilities via OSV.
#

set -euo pipefail

# Cap packages scanned to keep runtime reasonable.
MAX_PACKAGES=50
BATCH_SIZE=50
OSV_TIMEOUT=30
MAX_VULNS_PER_PKG=10
OSV_TOTAL_BUDGET=90

# Print progress to stderr so users see activity during long scans.
progress() {
  echo "[library-vulns] $*" >&2
}

check_libraries() {
  local envelope
  envelope=$(scan_envelope "library_vulns")

  local os_info
  os_info=$(detect_os)

  progress "enumerating installed packages..."
  local packages
  packages=$(enumerate_packages)
  local total
  total=$(echo "$packages" | jq 'length')
  progress "found $total installed packages"

  if [[ "$total" -eq 0 ]]; then
    merge_result "$envelope" \
      '{"summary": {"total_packages": 0, "vulnerable_packages": 0, "critical": 0, "high": 0, "medium": 0, "low": 0, "unknown": 0}, "details": [], "ok": true, "note": "No packages enumerated"}'
    return 0
  fi

  # Limit total packages and split into smaller batches so the OSV API responds
  # quickly and we can stream partial results instead of one giant request.
  local capped
  capped=$(echo "$packages" | jq --argjson max "$MAX_PACKAGES" '[limit($max; .[])]')
  total=$(echo "$capped" | jq 'length')
  if [[ "$total" -ge "$MAX_PACKAGES" ]]; then
    progress "capping scan to $MAX_PACKAGES packages for speed (use VULNSCAN_MAX_PACKAGES to override)"
  fi

  local all_results='[]'
  local start=0
  local batch_count=$(((total + BATCH_SIZE - 1) / BATCH_SIZE))
  local batch_num=0
  local osv_start=$SECONDS

  while [[ $start -lt $total ]]; do
    batch_num=$((batch_num + 1))

    if [[ $((SECONDS - osv_start)) -ge $OSV_TOTAL_BUDGET ]]; then
      progress "OSV query budget (${OSV_TOTAL_BUDGET}s) exhausted; using partial results"
      break
    fi

    progress "querying OSV batch $batch_num/$batch_count (${BATCH_SIZE} packages)..."
    local batch_query
    batch_query=$(echo "$capped" | jq \
      --argjson start "$start" \
      --argjson size "$BATCH_SIZE" \
      '[.[$start:$start+$size] | .[] | {package: {ecosystem: .ecosystem, name: .name}, version: .version}]')

    local batch_result
    # Use a separate curl invocation per batch so a slow batch cannot block
    # the whole scan indefinitely.
    set +e
    batch_result=$(curl -sL --max-time "$OSV_TIMEOUT" -X POST "https://api.osv.dev/v1/querybatch" \
      -H "Content-Type: application/json" \
      -d "{\"queries\": $batch_query}" 2>/dev/null)
    local curl_status=$?
    set -e

    if [[ $curl_status -ne 0 ]]; then
      progress "OSV batch $batch_num timed out or failed (curl exit $curl_status); stopping"
      break
    fi

    if [[ -z "$batch_result" ]] || ! echo "$batch_result" | jq -e . >/dev/null 2>&1; then
      progress "OSV batch $batch_num returned invalid JSON; stopping"
      break
    fi

    all_results=$(jq --slurpfile prev <(echo "$all_results") --slurpfile cur <(echo "$batch_result") \
      '($prev[0] // []) + ($cur[0].results // [])')

    start=$((start + BATCH_SIZE))
  done

  local result_count
  result_count=$(echo "$all_results" | jq 'length')
  progress "received $result_count OSV result entries"

  if [[ "$result_count" -eq 0 ]]; then
    merge_result "$envelope" \
      '{"summary": {"total_packages": '$total', "vulnerable_packages": 0, "critical": 0, "high": 0, "medium": 0, "low": 0, "unknown": 0}, "details": [], "ok": false, "error": "OSV query failed or returned no results"}'
    return 0
  fi

  progress "building report..."

  # Zip packages with their OSV results. Use temp files to avoid ARG_MAX
  # limits when passing large JSON arrays as jq arguments.
  local pkg_file result_file
  pkg_file=$(mktemp /tmp/vulnscan-pkgs.XXXXXX)
  result_file=$(mktemp /tmp/vulnscan-osv.XXXXXX)
  echo "$capped" > "$pkg_file"
  echo "{\"results\": $all_results}" > "$result_file"

  local details
  details=$(jq \
    --slurpfile packages "$pkg_file" \
    --slurpfile results "$result_file" \
    --argjson max "$MAX_PACKAGES" \
    --argjson max_vulns "$MAX_VULNS_PER_PKG" \
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
          ($vulns | limit($max_vulns; .[])) | {
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

  progress "done ($vulnerable vulnerable packages found)"

  jq --slurpfile details "$detail_file" --argjson summary "$summary" \
    '. + {ok: true, summary: $summary, details: $details[0]}' \
    <<< "$envelope"

  rm -f "$detail_file"
}
