# Automated Linux Vulnerability Scanner Scripts

Lightweight, read-only audit scripts for Linux servers. They enumerate system
state and cross-reference installed packages against the [Google OSV](https://osv.dev/)
database.

## Requirements

- `bash`
- `curl`
- `jq`

For the Docker check, Docker must be installed and the executing user must be
able to run `docker` commands.

## Quick start

Run directly from GitHub:

```bash
bash <(curl -sL https://raw.githubusercontent.com/<your-org>/<your-repo>/main/scripts/vulnscan.sh)
```

Or clone the repository and run locally:

```bash
./scripts/vulnscan.sh
```

## Available checks

| Check | Flag | Description |
|-------|------|-------------|
| Services status | `--services` | Lists running, failed, and other systemd services. |
| Docker status | `--docker` | Checks Docker daemon, containers, and scans image packages via OSV. |
| PM2 status | `--pm2` | Lists PM2 processes and their status. |
| Library vulnerabilities | `--library-vulns` | Enumerates system packages and queries OSV for CVEs. |
| Full scan | `--full` | Runs all of the above and returns one combined JSON report. |

## Output format

Every check prints a single JSON object to stdout, for example:

```json
{
  "scan_type": "library_vulns",
  "timestamp": "2026-11-17T12:00:00Z",
  "host": "server01",
  "ok": true,
  "summary": {
    "total_packages": 150,
    "vulnerable_packages": 3,
    "critical": 0,
    "high": 1,
    "medium": 2,
    "low": 0,
    "unknown": 0
  },
  "details": [...]
}
```

## Notes

- Scripts are read-only and do not modify the system.
- The OSV batch API is used to keep scan times short.
- Image vulnerability scanning runs a temporary container to enumerate packages
  and may be limited by image size and network speed.
