#!/usr/bin/env bash
#
# Check installed system libraries/packages for known vulnerabilities.
#
# Fast path: use the distribution's own update checker (apt, yum, dnf) when
# available. This is orders of magnitude faster than querying OSV for every
# package and works offline if the package index is current.
#
# OSV path: queries Google's OSV database. Used as a fallback or when the
# VULNSCAN_USE_OSV environment variable is set.
#

set -euo pipefail

# Cap packages scanned to keep runtime reasonable.
MAX_PACKAGES=${VULNSCAN_MAX_PACKAGES:-50}
BATCH_SIZE=50
OSV_TIMEOUT=25
OSV_TOTAL_BUDGET=60
MAX_VULNS_PER_PKG=10

# Print progress to stderr so users see activity during long scans.
progress() {
  echo "[library-vulns] $*" >&2
}

# Draw a percentage bar on stderr.
# Usage: progress_bar current total [label]
progress_bar() {
  local current="$1"
  local total="$2"
  local label="${3:-}"
  local width=30
  local pct=0
  if [[ "$total" -gt 0 ]]; then
    pct=$(( current * 100 / total ))
  fi
  local filled=$(( current * width / total ))
  local empty=$(( width - filled ))
  local bar=""
  for ((i = 0; i < filled; i++)); do bar+="="; done
  for ((i = 0; i < empty; i++)); do bar+="-"; done
  if [[ -n "$label" ]]; then
    printf "\r[library-vulns] [%s] %3d%% %s" "$bar" "$pct" "$label" >&2
  else
    printf "\r[library-vulns] [%s] %3d%%" "$bar" "$pct" >&2
  fi
}

# Clear the current progress bar line.
progress_bar_done() {
  printf "\r%-80s\r" "" >&2
}

# Return a numeric rank for a Debian/Ubuntu package priority string.
# Higher numbers are more important on a server.
priority_rank() {
  local p="${1,,}"
  case "$p" in
    required) echo 4 ;;
    important) echo 3 ;;
    standard) echo 2 ;;
    optional) echo 1 ;;
    extra) echo 0 ;;
    *) echo 0 ;;
  esac
}

# Minimum package priority to include in the report.
#   required -> only required packages
#   important -> required + important (default)
#   standard -> required + important + standard
#   optional -> include everything
MIN_PRIORITY="${VULNSCAN_MIN_PRIORITY:-important}"

# Packages that are not relevant on headless servers even if they appear in
# security repositories. These are typically desktop/icon/font dependencies.
server_irrelevant_blocklist() {
  jq -n '[
    "gtk-update-icon-cache", "adwaita-icon-theme", "hicolor-icon-theme",
    "humanity-icon-theme", "ubuntu-mono", "yaru-theme-icon", "gnome-icon-theme",
    "fonts-dejavu-core", "fontconfig-config", "libfontconfig1", "libgtk-3-0",
    "libgdk-pixbuf2.0-0", "libpango-1.0-0", "libcairo2", "libharfbuzz0b"
  ]'
}

# Look up Debian/Ubuntu package priorities for the packages in the input JSON.
# Input: JSON array of objects with a "name" field.
# Output: JSON object mapping package name -> lowercase priority.
get_apt_priorities() {
  local packages="$1"
  local names
  names=$(echo "$packages" | jq -r '[.[].name] | join("\n")')
  local query_output
  query_output=$(dpkg-query -W -f='${Package}\t${Priority}\n' $names 2>/dev/null || true)
  echo "$query_output" | jq -R -s '
    split("\n") |
    map(select(length > 0) | split("\t") | {(.[0]): (.[1] // "optional" | ascii_downcase)}) |
    add // {}
  '
}

# Query OSV for a small batch of packages and return results in input order.
# Input: JSON array of {name, version, ecosystem} objects.
# Output: JSON object with a "results" array.
query_osv_batch() {
  local packages="$1"
  local total
  total=$(echo "$packages" | jq 'length')
  if [[ "$total" -eq 0 ]]; then
    echo '{"results": []}'
    return 0
  fi

  local query
  query=$(echo "$packages" | jq '[.[] | {package: {ecosystem: .ecosystem, name: .name}, version: .version}]')

  local response
  local status=0
  set +e
  response=$(run_with_timeout "$OSV_TIMEOUT" \
    curl -sL -X POST "https://api.osv.dev/v1/querybatch" \
    -H "Content-Type: application/json" \
    -d "{\"queries\": $query}" 2>/dev/null)
  status=$?
  set -e

  if [[ $status -ne 0 ]] || [[ -z "$response" ]] || ! echo "$response" | jq -e . >/dev/null 2>&1; then
    echo '{"results": []}'
    return 0
  fi

  echo "$response"
}

# Run a command with a hard timeout. Prefers the system `timeout` utility;
# falls back to curl's --max-time for HTTP requests.
run_with_timeout() {
  local seconds="$1"
  shift
  if command -v timeout >/dev/null 2>&1; then
    timeout "$seconds" "$@"
  else
    "$@"
  fi
}

# Run a command and show a spinner on stderr until it finishes.
with_spinner() {
  local msg="$1"
  shift
  local start=$SECONDS

  "$@" &
  local pid=$!
  # Use simple ASCII spinner so every terminal can display it.
  local spin='|/-\'
  local i=0

  while kill -0 "$pid" 2>/dev/null; do
    i=$(( (i + 1) % 4 ))
    printf "\r[library-vulns] %s %s (%ss)" "$msg" "${spin:$i:1}" "$((SECONDS - start))" >&2
    sleep 0.5
  done

  wait "$pid"
  local status=$?
  printf "\r[library-vulns] %s done in %ss (exit %s)\n" "$msg" "$((SECONDS - start))" "$status" >&2
  return "$status"
}

# Fast Debian/Ubuntu check: simulate an upgrade and report packages that would
# be installed. This is the fastest way to know what is out of date.
check_apt_updates() {
  local envelope="$1"

  progress "using apt fast-path to find security updates..."

  local apt_output
  if ! apt_output=$(with_spinner "waiting for apt" run_with_timeout 30 apt-get -s upgrade 2>/dev/null); then
    return 1
  fi

  # Parse lines like: "Inst python3 [3.10.6-1~22.04] (3.10.6-1~22.04.1 Ubuntu:22.04/jammy-security [amd64])"
  # We only care about packages coming from a security repository.
  local apt_re='^Inst[[:space:]]+([^[:space:]]+)[[:space:]]+\[([^]]+)\][[:space:]]+\(([^)]+)\)'
  local candidates="[]"
  while IFS= read -r line; do
    if [[ "$line" =~ $apt_re ]]; then
      local name="${BASH_REMATCH[1]}"
      local old_version="${BASH_REMATCH[2]}"
      local inner="${BASH_REMATCH[3]}"
      local new_version="${inner%% *}"
      local repo_info="${inner#* }"

      # Only flag packages from a security repository.
      if [[ "$repo_info" != *security* && "$repo_info" != *Security* ]]; then
        continue
      fi

      candidates=$(echo "$candidates" | jq \
        --arg name "$name" \
        --arg old_version "$old_version" \
        --arg new_version "$new_version" \
        --arg repo "$repo_info" \
        '. + [{name: $name, version: $old_version, ecosystem: "Debian", update_available: $new_version, repository: $repo}]')
    fi
  done <<< "$apt_output"

  local total_candidates
  total_candidates=$(echo "$candidates" | jq 'length')
  if [[ "$total_candidates" -eq 0 ]]; then
    local summary
    summary=$(jq -n '{total_packages: 0, vulnerable_packages: 0, critical: 0, high: 0, medium: 0, low: 0, unknown: 0}')
    merge_result "$envelope" \
      "$(jq -n --argjson summary "$summary" --arg note "apt reports no pending security updates" '{ok: true, summary: $summary, details: [], note: $note}')"
    return 0
  fi

  progress "found $total_candidates pending security updates; checking package priorities..."

  local priorities
  priorities=$(get_apt_priorities "$candidates")

  local min_rank
  min_rank=$(priority_rank "$MIN_PRIORITY")

  local blocked
  blocked=$(server_irrelevant_blocklist)

  local filtered
  filtered=$(echo "$candidates" | jq \
    --argjson priorities "$priorities" \
    --argjson blocked "$blocked" \
    --argjson min_rank "$min_rank" \
    '[.[] |
      (.name as $n | $priorities[$n] // "optional") as $priority |
      select(
        (([$priority] | add | if . == "required" then 4 elif . == "important" then 3 elif . == "standard" then 2 elif . == "optional" then 1 else 0 end) >= $min_rank) and
        (.name as $n | $blocked | index($n) | not)
      ) |
      .priority = $priority
    ]')

  local filtered_count
  filtered_count=$(echo "$filtered" | jq 'length')
  local skipped_count=$((total_candidates - filtered_count))
  if [[ "$skipped_count" -gt 0 ]]; then
    progress "skipped $skipped_count low-priority or server-irrelevant packages (set VULNSCAN_MIN_PRIORITY=standard/optional to include more)"
  fi

  if [[ "$filtered_count" -eq 0 ]]; then
    local summary
    summary=$(jq -n --argjson total "$total_candidates" '{total_packages: $total, vulnerable_packages: 0, critical: 0, high: 0, medium: 0, low: 0, unknown: 0}')
    merge_result "$envelope" \
      "$(jq -n --argjson summary "$summary" --arg note "No must-update security packages found (all pending updates are low-priority). Set VULNSCAN_MIN_PRIORITY=standard to include standard-priority updates." '{ok: true, summary: $summary, details: [], note: $note}')"
    return 0
  fi

  progress "querying OSV for severity data on $filtered_count must-update packages..."
  local osv_response
  osv_response=$(query_osv_batch "$filtered")

  local details
  details=$(echo "$filtered" | jq \
    --argjson osv "$osv_response" \
    --argjson max_vulns "$MAX_VULNS_PER_PKG" \
    '
    def max_cvss:
      [ (.severity // [])[] | select(.type == "CVSS_V3" or .type == "CVSS_V4") | (.score | try tonumber catch null) ] | max // null;
    def severity_label(score):
      if score == null then "UNKNOWN"
      elif score >= 9.0 then "CRITICAL"
      elif score >= 7.0 then "HIGH"
      elif score >= 4.0 then "MEDIUM"
      else "LOW"
      end;
    [ to_entries | .[] |
      .key as $idx |
      .value as $pkg |
      ($osv.results[$idx].vulns // []) as $vulns |
      {
        name: $pkg.name,
        version: $pkg.version,
        ecosystem: $pkg.ecosystem,
        priority: $pkg.priority,
        update_available: $pkg.update_available,
        repository: $pkg.repository,
        vulnerability_count: ($vulns | length),
        vulnerabilities: [
          ($vulns | limit($max_vulns; .[])) | {
            id: .id,
            summary: (.summary // .details // "No summary"),
            severity: (severity_label(max_cvss)),
            cvss_score: max_cvss,
            aliases: (.aliases // [])
          }
        ]
      }
    ]')

  local vulnerable critical high medium low unknown
  vulnerable=$(echo "$details" | jq '[.[] | select(.vulnerability_count > 0)] | length')
  critical=$(echo "$details" | jq '[.[].vulnerabilities[]? | select((.severity | type == "string" and (. | ascii_downcase) == "critical"))] | length')
  high=$(echo "$details" | jq '[.[].vulnerabilities[]? | select((.severity | type == "string" and (. | ascii_downcase) == "high"))] | length')
  medium=$(echo "$details" | jq '[.[].vulnerabilities[]? | select((.severity | type == "string" and (. | ascii_downcase) == "medium"))] | length')
  low=$(echo "$details" | jq '[.[].vulnerabilities[]? | select((.severity | type == "string" and (. | ascii_downcase) == "low"))] | length')
  unknown=$(echo "$details" | jq '[.[].vulnerabilities[]? | select((.severity | type == "string" and (. | ascii_downcase) == "unknown") or .severity == null)] | length')

  local summary
  summary=$(jq -n \
    --argjson total "$total_candidates" \
    --argjson vulnerable "$vulnerable" \
    --argjson critical "$critical" \
    --argjson high "$high" \
    --argjson medium "$medium" \
    --argjson low "$low" \
    --argjson unknown "$unknown" \
    '{total_packages: $total, vulnerable_packages: $vulnerable, critical: $critical, high: $high, medium: $medium, low: $low, unknown: $unknown}')

  local note="Security updates for must-update packages (priority >= $MIN_PRIORITY)."
  [[ "$vulnerable" -eq 0 ]] && note="$note OSV had no CVE data for these packages, but they are security updates and should be applied."

  merge_result "$envelope" \
    "$(jq -n --argjson summary "$summary" --argjson details "$details" --arg note "$note" '{ok: true, summary: $summary, details: $details, note: $note}')"
}

# Fast Red Hat/CentOS/Rocky/Fedora check.
check_yum_updates() {
  local envelope="$1"

  progress "using yum/dnf fast-path to find outdated packages..."

  local cmd
  if command -v dnf >/dev/null 2>&1; then
    if dnf --help 2>/dev/null | grep -q -- '--security'; then
      cmd="dnf --security check-update -q"
    else
      cmd="dnf check-update -q"
    fi
  elif command -v yum >/dev/null 2>&1; then
    if yum --help 2>/dev/null | grep -q -- '--security'; then
      cmd="yum --security check-update -q"
    else
      cmd="yum check-update -q"
    fi
  else
    return 1
  fi

  local output
  local status=0
  output=$(run_with_timeout 60 $cmd 2>/dev/null) || status=$?
  # yum/dnf exits 100 when updates are available; other non-zero codes mean failure.
  if [[ "$status" -ne 0 && "$status" -ne 100 ]]; then
    return 1
  fi

  local candidates="[]"
  local pkg_count=0
  while IFS= read -r line; do
    # Lines like: "python3.x86_64  3.9.18-1.el9_3.1  updates"
    local name version repo
    name=$(echo "$line" | awk '{print $1}')
    version=$(echo "$line" | awk '{print $2}')
    repo=$(echo "$line" | awk '{print $3}')
    [[ -z "$name" || -z "$version" ]] && continue
    pkg_count=$((pkg_count + 1))
    candidates=$(echo "$candidates" | jq \
      --arg name "$name" \
      --arg version "$version" \
      --arg repo "$repo" \
      '. + [{name: $name, version: "unknown", ecosystem: "Red Hat", update_available: $version, repository: $repo}]')
  done <<< "$output"

  if [[ "$pkg_count" -eq 0 ]]; then
    local summary
    summary=$(jq -n '{total_packages: 0, vulnerable_packages: 0, critical: 0, high: 0, medium: 0, low: 0, unknown: 0}')
    merge_result "$envelope" \
      "$(jq -n --argjson summary "$summary" --arg note "yum/dnf reports no pending security updates" '{ok: true, summary: $summary, details: [], note: $note}')"
    return 0
  fi

  # Filter out server-irrelevant packages (RPM has no standard priority field).
  local blocked
  blocked=$(server_irrelevant_blocklist)
  local filtered
  filtered=$(echo "$candidates" | jq \
    --argjson blocked "$blocked" \
    '[.[] | select(.name as $n | $blocked | index($n) | not)]')

  local filtered_count
  filtered_count=$(echo "$filtered" | jq 'length')
  local skipped_count=$((pkg_count - filtered_count))
  [[ "$skipped_count" -gt 0 ]] && progress "skipped $skipped_count server-irrelevant packages"

  progress "querying OSV for severity data on $filtered_count packages..."
  local osv_response
  osv_response=$(query_osv_batch "$filtered")

  local details
  details=$(echo "$filtered" | jq \
    --argjson osv "$osv_response" \
    --argjson max_vulns "$MAX_VULNS_PER_PKG" \
    '
    def max_cvss:
      [ (.severity // [])[] | select(.type == "CVSS_V3" or .type == "CVSS_V4") | (.score | try tonumber catch null) ] | max // null;
    def severity_label(score):
      if score == null then "UNKNOWN"
      elif score >= 9.0 then "CRITICAL"
      elif score >= 7.0 then "HIGH"
      elif score >= 4.0 then "MEDIUM"
      else "LOW"
      end;
    [ to_entries | .[] |
      .key as $idx |
      .value as $pkg |
      ($osv.results[$idx].vulns // []) as $vulns |
      {
        name: $pkg.name,
        version: $pkg.version,
        ecosystem: $pkg.ecosystem,
        update_available: $pkg.update_available,
        repository: $pkg.repository,
        vulnerability_count: ($vulns | length),
        vulnerabilities: [
          ($vulns | limit($max_vulns; .[])) | {
            id: .id,
            summary: (.summary // .details // "No summary"),
            severity: (severity_label(max_cvss)),
            cvss_score: max_cvss,
            aliases: (.aliases // [])
          }
        ]
      }
    ]')

  local vulnerable critical high medium low unknown
  vulnerable=$(echo "$details" | jq '[.[] | select(.vulnerability_count > 0)] | length')
  critical=$(echo "$details" | jq '[.[].vulnerabilities[]? | select((.severity | type == "string" and (. | ascii_downcase) == "critical"))] | length')
  high=$(echo "$details" | jq '[.[].vulnerabilities[]? | select((.severity | type == "string" and (. | ascii_downcase) == "high"))] | length')
  medium=$(echo "$details" | jq '[.[].vulnerabilities[]? | select((.severity | type == "string" and (. | ascii_downcase) == "medium"))] | length')
  low=$(echo "$details" | jq '[.[].vulnerabilities[]? | select((.severity | type == "string" and (. | ascii_downcase) == "low"))] | length')
  unknown=$(echo "$details" | jq '[.[].vulnerabilities[]? | select((.severity | type == "string" and (. | ascii_downcase) == "unknown") or .severity == null)] | length')

  local summary
  summary=$(jq -n \
    --argjson total "$pkg_count" \
    --argjson vulnerable "$vulnerable" \
    --argjson critical "$critical" \
    --argjson high "$high" \
    --argjson medium "$medium" \
    --argjson low "$low" \
    --argjson unknown "$unknown" \
    '{total_packages: $total, vulnerable_packages: $vulnerable, critical: $critical, high: $high, medium: $medium, low: $low, unknown: $unknown}')

  local note="Security updates available from yum/dnf."
  [[ "$vulnerable" -eq 0 ]] && note="$note OSV had no CVE data for these packages, but they are security updates and should be applied."

  merge_result "$envelope" \
    "$(jq -n --argjson summary "$summary" --argjson details "$details" --arg note "$note" '{ok: true, summary: $summary, details: $details, note: $note}')"
}

# Slow OSV-based check. Kept as a fallback for users who explicitly want CVE
# data or are on a distro without apt/yum.
check_osv() {
  local envelope="$1"
  local packages="$2"
  local total
  total=$(echo "$packages" | jq 'length')

  progress "using OSV slow-path for CVE data..."

  local capped
  capped=$(echo "$packages" | jq --argjson max "$MAX_PACKAGES" '[limit($max; .[])]')
  total=$(echo "$capped" | jq 'length')
  if [[ "$total" -ge "$MAX_PACKAGES" ]]; then
    progress "capping OSV scan to $MAX_PACKAGES packages for speed (set VULNSCAN_MAX_PACKAGES=N to change)"
  fi

  local all_results='[]'
  local start=0
  local batch_count=$(((total + BATCH_SIZE - 1) / BATCH_SIZE))
  local batch_num=0
  local osv_start=$SECONDS
  local timed_out=false

  progress_bar 0 "$batch_count" "OSV batch 0/$batch_count"
  while [[ $start -lt $total ]]; do
    batch_num=$((batch_num + 1))

    if [[ $((SECONDS - osv_start)) -ge $OSV_TOTAL_BUDGET ]]; then
      progress_bar_done
      progress "OSV total time budget (${OSV_TOTAL_BUDGET}s) reached; stopping with partial results"
      timed_out=true
      break
    fi

    local batch_query
    batch_query=$(echo "$capped" | jq \
      --argjson start "$start" \
      --argjson size "$BATCH_SIZE" \
      '[.[$start:$start+$size] | .[] | {package: {ecosystem: .ecosystem, name: .name}, version: .version}]')

    progress_bar "$((batch_num - 1))" "$batch_count" "OSV batch $batch_num/$batch_count (timeout ${OSV_TIMEOUT}s)"
    local batch_result
    local curl_status=0

    set +e
    batch_result=$(with_spinner "waiting for OSV" \
      run_with_timeout "$OSV_TIMEOUT" \
      curl -sL -X POST "https://api.osv.dev/v1/querybatch" \
      -H "Content-Type: application/json" \
      -d "{\"queries\": $batch_query}" 2>/dev/null)
    curl_status=$?
    set -e

    if [[ $curl_status -ne 0 ]]; then
      progress_bar_done
      progress "OSV batch $batch_num request failed or timed out (exit $curl_status); stopping"
      timed_out=true
      break
    fi

    if [[ -z "$batch_result" ]] || ! echo "$batch_result" | jq -e . >/dev/null 2>&1; then
      progress_bar_done
      progress "OSV batch $batch_num returned invalid JSON; stopping"
      timed_out=true
      break
    fi

    all_results=$(jq --slurpfile prev <(echo "$all_results") --slurpfile cur <(echo "$batch_result") \
      '($prev[0] // []) + ($cur[0].results // [])')

    progress_bar "$batch_num" "$batch_count" "OSV batch $batch_num/$batch_count done"
    start=$((start + BATCH_SIZE))
  done
  progress_bar_done

  local result_count
  result_count=$(echo "$all_results" | jq 'length')
  progress "received $result_count OSV result entries"

  if [[ "$result_count" -eq 0 ]]; then
    progress "OSV returned no vulnerability data; returning package list only"
    local pkg_list
    pkg_list=$(echo "$capped" | jq '[.[] | {name, version, ecosystem, vulnerability_count: 0, vulnerabilities: []}]')
    local note="OSV query failed or timed out; package list shown without vulnerability data"
    [[ "$timed_out" == true ]] && note="OSV query timed out after ${OSV_TOTAL_BUDGET}s; package list shown without vulnerability data"

    local summary
    summary=$(jq -n --argjson total "$total" '{total_packages: $total, vulnerable_packages: 0, critical: 0, high: 0, medium: 0, low: 0, unknown: 0}')

    merge_result "$envelope" \
      "$(jq -n --argjson summary "$summary" --argjson details "$pkg_list" --arg note "$note" '{ok: true, summary: $summary, details: $details, note: $note}')"
    return 0
  fi

  progress "building report..."

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
            severity: (
              (
                [ (.severity // [])[] | select(.type == "CVSS_V3" or .type == "CVSS_V4") | (.score | try tonumber catch null) ] | max // null
              ) as $score |
              if $score == null then "UNKNOWN"
              elif $score >= 9.0 then "CRITICAL"
              elif $score >= 7.0 then "HIGH"
              elif $score >= 4.0 then "MEDIUM"
              else "LOW"
              end
            ),
            cvss_score: (
              [ (.severity // [])[] | select(.type == "CVSS_V3" or .type == "CVSS_V4") | (.score | try tonumber catch null) ] | max // null
            ),
            aliases: (.aliases // [])
          }
        ]
      }
    ]')

  rm -f "$pkg_file" "$result_file"

  local vulnerable critical high medium low unknown
  vulnerable=$(echo "$details" | jq '[.[] | select(.vulnerability_count > 0)] | length')
  critical=$(echo "$details" | jq '[.[].vulnerabilities[]? | select((.severity | type == "string" and (. | ascii_downcase) == "critical"))] | length')
  high=$(echo "$details" | jq '[.[].vulnerabilities[]? | select((.severity | type == "string" and (. | ascii_downcase) == "high"))] | length')
  medium=$(echo "$details" | jq '[.[].vulnerabilities[]? | select((.severity | type == "string" and (. | ascii_downcase) == "medium"))] | length')
  low=$(echo "$details" | jq '[.[].vulnerabilities[]? | select((.severity | type == "string" and (. | ascii_downcase) == "low"))] | length')
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

  # If the user explicitly wants OSV, use it. Otherwise use the fast distro path.
  if [[ "${VULNSCAN_USE_OSV:-0}" == "1" ]]; then
    check_osv "$envelope" "$packages"
    return $?
  fi

  local id
  id=$(echo "$os_info" | jq -r '.id')
  case "$id" in
    debian|ubuntu|linuxmint|pop)
      if command -v apt-get >/dev/null 2>&1; then
        check_apt_updates "$envelope"
        return $?
      fi
      ;;
    fedora|rhel|centos|rocky|almalinux|amzn)
      if command -v dnf >/dev/null 2>&1 || command -v yum >/dev/null 2>&1; then
        check_yum_updates "$envelope"
        return $?
      fi
      ;;
  esac

  progress "no fast distro updater available; falling back to OSV"
  check_osv "$envelope" "$packages"
}
