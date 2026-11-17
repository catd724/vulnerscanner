#!/usr/bin/env bash
#
# Check Docker daemon, containers, and image vulnerabilities.
#

set -euo pipefail

# Determine the package manager command to run inside a container based on OS hints.
image_pkg_command() {
  local image="$1"
  # Probe the image with a minimal command.
  if docker run --rm "$image" sh -c 'command -v dpkg-query' >/dev/null 2>&1; then
    echo "dpkg-query -W -f='{{Package}}\\t{{Version}}\\n' 2>/dev/null || true"
    return 0
  fi
  if docker run --rm "$image" sh -c 'command -v rpm' >/dev/null 2>&1; then
    echo "rpm -qa --queryformat '%{NAME}\\t%{VERSION}-%{RELEASE}\\n' 2>/dev/null || true"
    return 0
  fi
  if docker run --rm "$image" sh -c 'command -v apk' >/dev/null 2>&1; then
    echo "apk list -I 2>/dev/null | awk '{full=\$1; name=full; sub(/-[0-9].*\$/, \"\", name); version=full; sub(\"^\"name\"-\", \"\", version); printf \"%s\\t%s\\n\", name, version}' || true"
    return 0
  fi
  return 1
}

# List packages inside a Docker image as JSON array {name, version, ecosystem}.
enumerate_image_packages() {
  local image="$1"
  local cmd
  if ! cmd=$(image_pkg_command "$image"); then
    echo '[]'
    return 0
  fi

  local raw
  if ! raw=$(docker run --rm "$image" sh -c "$cmd" 2>/dev/null); then
    echo '[]'
    return 0
  fi

  # Detect ecosystem from the image itself.
  local ecosystem="Linux"
  if docker run --rm "$image" sh -c 'command -v dpkg-query' >/dev/null 2>&1; then
    ecosystem="Debian"
  elif docker run --rm "$image" sh -c 'command -v rpm' >/dev/null 2>&1; then
    if docker run --rm "$image" sh -c 'test -f /etc/redhat-release' >/dev/null 2>&1; then
      ecosystem="Red Hat"
    else
      ecosystem="openSUSE"
    fi
  elif docker run --rm "$image" sh -c 'command -v apk' >/dev/null 2>&1; then
    ecosystem="Alpine"
  fi

  # Parse tab-separated lines into JSON.
  local jsonl=""
  while IFS=$'\t' read -r name version _; do
    [[ -z "$name" || -z "$version" ]] && continue
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

  # Check each image for vulnerabilities.
  local image_details="[]"
  local vulnerable=0
  local idx=0

  while [[ $idx -lt $image_count ]]; do
    local image_obj image_id
    image_obj=$(echo "$images" | jq ".[$idx]")
    image_id=$(echo "$image_obj" | jq -r '.ID')

    local pkgs
    pkgs=$(enumerate_image_packages "$image_id")

    # Batch query OSV for up to 50 packages to keep runtime reasonable.
    local batch_query batch_result vuln_list
    batch_query=$(echo "$pkgs" | jq -s '[limit(50; .[] | {package: {ecosystem: .ecosystem, name: .name}, version: .version})]')
    if [[ $(echo "$batch_query" | jq 'length') -gt 0 ]]; then
      batch_result=$(curl -sL --max-time 30 -X POST "https://api.osv.dev/v1/querybatch" \
        -H "Content-Type: application/json" \
        -d "{\"queries\": $batch_query}" 2>/dev/null || echo '{"results": []}')
      vuln_list=$(echo "$batch_result" | jq '[.results[]? | select(.vulns) | .vulns[]? | {id: .id, summary: (.summary // .details // "No summary"), severity: ((.severity // []) | if length > 0 then .[0].score else "UNKNOWN" end)}]')
    else
      vuln_list='[]'
    fi

    local img_vuln_count
    img_vuln_count=$(echo "$vuln_list" | jq 'length')
    if [[ "$img_vuln_count" -gt 0 ]]; then
      vulnerable=$((vulnerable + 1))
    fi

    image_details=$(echo "$image_details" | jq \
      --argjson img "$image_obj" \
      --argjson vulns "$vuln_list" \
      --argjson pkg_count "$(echo "$pkgs" | jq 'length')" \
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
