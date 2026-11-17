#!/usr/bin/env bash
#
# Check installed system libraries/packages for known vulnerabilities via OSV.
#

set -euo pipefail

# Cap packages scanned to keep runtime reasonable.
MAX_PACKAGES=${VULNSCAN_MAX_PACKAGES:-50}
BATCH_SIZE=50
OSV_TIMEOUT=25
MAX_VULNS_PER_PKG=10
OSV_TOTAL_BUDGET=60

# Print progress to stderr so users see activity during long scans.
progress() {
  echo "[library-vulns] $*" >&2
}

# Run a command and show a spinner on stderr until it finishes.
# Prints elapsed time and command status for visibility.
with_spinner() {
  local msg="$1"
  shift
  local tmpfile
  tmpfile=$(mktemp /tmp/vulnscan-spinner.XXXXXX)
  local start=$SECONDS

  "$@" &
  local pid=$!
  local spin='⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
  local i=0

  while kill -0 "$pid" 2>/dev/null; do
    i=$(( (i + 1) % ${#spin} ))
    printf "\r[library-vulns] %s %s (%ss) " "$msg" "${spin:$i:1}" "$((SECONDS - start))" >&2
    sleep 0.15
  done

  wait "$pid"
  local status=$?
  printf "\r[library-vulns] %s done in %ss (exit %s)\n" "$msg" "$((SECONDS - start))" "$status" >&2
  return "$status"
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
    progress "capping scan to $MAX_PACKAGES packages for speed (set VULNSCAN_MAX_PACKAGES=N to change)"
  fi

  local all_results='[]'
  local start=0
  local batch_count=$(((total + BATCH_SIZE - 1) / BATCH_SIZE))
  local batch_num=0
  local osv_start=$SECONDS
  local timed_out=false

  while [[ $start -lt $total ]]; do
    batch_num=$((batch_num + 1))

    if [[ $((SECONDS - osv_start)) -ge $OSV_TOTAL_BUDGET ]]; then
      progress "OSV total time budget (${OSV_TOTAL_BUDGET}s) reached; stopping with partial results"
      timed_out=true
      break
    fi

    progress "preparing OSV batch $batch_num/$batch_count (${BATCH_SIZE} packages)..."
    local batch_query
    batch_query=$(echo "$capped" | jq \
      --argjson start "$start" \
      --argjson size "$BATCH_SIZE" \
      '[.[$start:$start+$size] | .[] | {package: {ecosystem: .ecosystem, name: .name}, version: .version}]')

    local batch_result
    local curl_status=0

    # Show a spinner while waiting for OSV so the user knows work is happening.
    set +e
    batch_result=$(with_spinner "querying OSV batch $batch_num/$batch_count" \
      curl -sL --max-time "$OSV_TIMEOUT" -X POST "https://api.osv.dev/v1/querybatch" \
      -H "Content-Type: application/json" \
      -d "{\"queries\": $batch_query}" 2>/dev/null)
    curl_status=$?
    set -e

    if [[ $curl_status -ne 0 ]]; then
      progress "OSV batch $batch_num request failed or timed out after ${OSV_TIMEOUT}s; stopping"
      timed_out=true
      break
    fi

    if [[ -z "$batch_result" ]] || ! echo "$batch_result" | jq -e . >/dev/null 2>&1; then
      progress "OSV batch $batch_num returned invalid JSON; stopping"
      timed_out=true
      break
    fi

    all_results=$(jq --slurpfile prev <(echo "$all_results") --slurpfile cur <(echo "$batch_result") \
      '($prev[0] // []) + ($cur[0].results // [])')

    start=$((start + BATCH_SIZE))
  done

  local result_count
  result_count=$(echo "$all_results" | jq 'length')
  progress "received $result_count OSV result entries"

  # If OSV did not return usable data, still return the package list so the user
  # sees the most recently scanned packages and knows the enumeration worked.
  if [[ "$result_count" -eq 0 ]]; then
    progress "OSV returned no vulnerability data; returning package list only"
    local pkg_list
    pkg_list=$(echo "$capped" | jq '[.[] | {name, version, ecosystem, vulnerability_count: 0, vulnerabilities: []}]')
    local note="OSV query failed or timed out; package list shown without vulnerability data"
    [[ "$timed_out" == true ]] && note="OSV query timed out after ${OSV_TOTAL_BUDGET}s; package list shown without vulnerability data"

    local summary
    summary=$(jq -n \
      --argjson total "$total" \
      '{total_packages: $total, vulnerable_packages: 0, critical: 0, high: 0, medium: 0, low: 0, unknown: 0}')

    merge_result "$envelope" \
      "$(jq -n --argjson summary "$summary" --argjson details "$pkg_list" --arg note "$note" '{ok: true, summary: $summary, details: $details, note: $note}')"
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

  local note=""
  [[ "$timed_out" == true ]] && note="OSV query stopped after ${OSV_TOTAL_BUDGET}s; results may be partial"

  progress "done ($vulnerable vulnerable packages found)"

  if [[ -n "$note" ]]; then
    jq --slurpfile details "$detail_file" --argjson summary "$summary" --arg note "$note" \
      '. + {ok: true, summary: $summary, details: $details[0], note: $note}' \
      <<< "$envelope"
  else
    jq --slurpfile details "$detail_file" --argjson summary "$summary" \
      '. + {ok: true, summary: $summary, details: $details[0]}' \
      <<< "$envelope"
  fi

  rm -f "$detail_file"
}
