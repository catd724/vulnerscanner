#!/usr/bin/env bash
#
# Check Docker daemon, containers, and image vulnerabilities.
#

set -euo pipefail

# Limit how many images we deeply inspect to keep runtime reasonable.
MAX_IMAGES=10
BATCH_SIZE=25
OSV_TIMEOUT=30

# Run a single command inside the image that detects the package manager and
# lists packages. This avoids the previous 3+ container startups per image.
enumerate_image_packages() {
  local image="$1"

  local raw
  raw=$(docker run --rm "$image" sh -c '
    if command -v dpkg-query >/dev/null 2>&1; then
      echo "ECO:Debian"
      dpkg-query -W -f="${Package}\t${Version}\n" 2>/dev/null || true
    elif command -v rpm >/dev/null 2>&1; then
      if test -f /etc/redhat-release; then
        echo "ECO:Red Hat"
      else
        echo "ECO:openSUSE"
      fi
      rpm -qa --queryformat "%{NAME}\t%{VERSION}-%{RELEASE}\n" 2>/dev/null || true
    elif command -v apk >/dev/null 2>&1; then
      echo "ECO:Alpine"
      apk list -I 2>/dev/null | while read -r full _; do
        name=${full%%-[0-9]*}
        version=${full#$name-}
        printf "%s\t%s\n" "$name" "$version"
      done || true
    else
      echo "ECO:Linux"
    fi
  ' 2>/dev/null)

  local ecosystem="Linux"
  local jsonl=""
  while IFS=$'\t' read -r name version; do
    [[ -z "$name" ]] && continue
    if [[ "$name" == "ECO:"* ]]; then
      ecosystem="${name#ECO:}"
      continue
    fi
    [[ -z "$version" ]] && continue
    jsonl+="{\"name\":\"$name\",\"version\":\"$version\",\"ecosystem\":\"$ecosystem\"}"
  done <<< "$raw"

  if [[ -z "$jsonl" ]]; then
    echo '[]'
  else
    echo "$jsonl" | jq -s '.'
  fi
}

check_docker() {
  local envelope
  envelope=$(scan_envelope "docker")

  if ! command -v docker >/dev/null 2>&1; then
    merge_result "$envelope" \
      '{"summary": {"daemon_up": false, "containers": 0, "images": 0, "vulnerable_images": 0}, "details": {"containers": [], "images": []}, "ok": true, "note": "docker not installed"}'
    return 0
  fi

  if ! docker info >/dev/null 2>&1; then
    merge_result "$envelope" \
      '{"summary": {"daemon_up": false, "containers": 0, "images": 0, "vulnerable_images": 0}, "details": {"containers": [], "images": []}, "ok": true, "note": "docker daemon is not running or user lacks permissions"}'
    return 0
  fi

  local containers images
  containers=$(docker ps -a --format '{{json .}}' 2>/dev/null | jq -s '.' || echo '[]')
  images=$(docker images --format '{{json .}}' 2>/dev/null | jq -s '.' || echo '[]')

  local image_count
  image_count=$(echo "$images" | jq 'length')

  # Check each image for vulnerabilities, but cap the number inspected.
  local image_details="[]"
  local vulnerable=0
  local idx=0
  local inspected=0

  while [[ $idx -lt $image_count && $inspected -lt $MAX_IMAGES ]]; do
    local image_obj image_id
    image_obj=$(echo "$images" | jq ".[$idx]")
    image_id=$(echo "$image_obj" | jq -r '.ID')

    local pkgs
    pkgs=$(enumerate_image_packages "$image_id")
    inspected=$((inspected + 1))

    # Batch query OSV in smaller chunks to keep each request fast.
    local vuln_list='[]'
    local pkg_total
    pkg_total=$(echo "$pkgs" | jq 'length')
    if [[ "$pkg_total" -gt 0 ]]; then
      local start=0
      while [[ $start -lt $pkg_total ]]; do
        local batch_query batch_result
        batch_query=$(echo "$pkgs" | jq \
          --argjson start "$start" \
          --argjson size "$BATCH_SIZE" \
          '[.[$start:$start+$size] | .[] | {package: {ecosystem: .ecosystem, name: .name}, version: .version}]')

        set +e
        batch_result=$(curl -sL --max-time "$OSV_TIMEOUT" -X POST "https://api.osv.dev/v1/querybatch" \
          -H "Content-Type: application/json" \
          -d "{\"queries\": $batch_query}" 2>/dev/null)
        set -e

        if [[ -n "$batch_result" ]] && echo "$batch_result" | jq -e . >/dev/null 2>&1; then
          vuln_list=$(jq --slurpfile prev <(echo "$vuln_list") --slurpfile cur <(echo "$batch_result") \
            '($prev[0] // []) + [($cur[0].results // [])[] | select(.vulns) | .vulns[]? | {id: .id, summary: (.summary // .details // "No summary"), severity: ((.severity // []) | if length > 0 then .[0].score else "UNKNOWN" end)}]')
        fi

        start=$((start + BATCH_SIZE))
      done
    fi

    local img_vuln_count
    img_vuln_count=$(echo "$vuln_list" | jq 'length')
    if [[ "$img_vuln_count" -gt 0 ]]; then
      vulnerable=$((vulnerable + 1))
    fi

    image_details=$(echo "$image_details" | jq \
      --argjson img "$image_obj" \
      --argjson vulns "$vuln_list" \
      --argjson pkg_count "$pkg_total" \
      '. + [$img + {packages_scanned: $pkg_count, vulnerabilities: $vulns}]')

    idx=$((idx + 1))
  done

  local summary
  summary=$(jq -n \
    --argjson containers "$(echo "$containers" | jq 'length')" \
    --argjson images "$image_count" \
    --argjson vulnerable "$vulnerable" \
    '{daemon_up: true, containers: $containers, images: $images, vulnerable_images: $vulnerable}')

  local details
  details=$(jq -n \
    --argjson containers "$containers" \
    --argjson images "$image_details" \
    '{containers: $containers, images: $images}')

  merge_result "$envelope" \
    "$(jq -n --argjson summary "$summary" --argjson details "$details" '{ok: true, summary: $summary, details: $details}')"
}
