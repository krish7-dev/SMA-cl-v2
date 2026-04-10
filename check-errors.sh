#!/usr/bin/env bash
# check-errors.sh — Find runtime errors across all services (runs ON EC2)
# Usage:
#   ./check-errors.sh           — log errors + health check
#   ./check-errors.sh logs 200  — scan last N lines (default 500)

set -euo pipefail

MODE="${1:-all}"
LOG_TAIL="${2:-500}"

RED='\033[0;31m'
YEL='\033[1;33m'
GRN='\033[0;32m'
CYN='\033[0;36m'
RST='\033[0m'

SERVICES=("broker" "execution" "data" "strategy")

declare -A PORTS=(
  [broker]=9003
  [execution]=9004
  [data]=9005
  [strategy]=9006
)

declare -A LOGS=(
  [broker]="$HOME/logs/broker.log"
  [execution]="$HOME/logs/execution.log"
  [data]="$HOME/logs/data.log"
  [strategy]="$HOME/logs/strategy.log"
)

# ── Helpers ────────────────────────────────────────────────────────────────────

section() { echo -e "\n${CYN}══════════════════════════════════════${RST}"; echo -e "${CYN}  $1${RST}"; echo -e "${CYN}══════════════════════════════════════${RST}"; }
ok()      { echo -e "  ${GRN}✔${RST}  $1"; }
warn()    { echo -e "  ${YEL}⚠${RST}  $1"; }
err()     { echo -e "  ${RED}✘${RST}  $1"; }
hdr()     { echo -e "  ${YEL}── $1 ──${RST}"; }

LOG_ERRORS=0

# ── 1. Log Error Check ─────────────────────────────────────────────────────────

run_log_check() {
  section "Log Error Check (last $LOG_TAIL lines per service)"

  for svc in "${SERVICES[@]}"; do
    log_path="${LOGS[$svc]}"
    echo -e "\n  ${CYN}[$svc]${RST}  $log_path"

    if [ ! -f "$log_path" ]; then
      warn "$svc — log file not found"
      continue
    fi

    matches=$(tail -n "$LOG_TAIL" "$log_path" \
      | grep -E ' ERROR | WARN ' \
      | grep -v 'HikariPool\|HealthContributor' \
      || true)

    err_count=$(echo "$matches" | grep -c ' ERROR ' 2>/dev/null || true)
    wrn_count=$(echo "$matches" | grep -c ' WARN '  2>/dev/null || true)

    err_count=${err_count:-0}
    wrn_count=${wrn_count:-0}

    if [ "$err_count" -eq 0 ] && [ "$wrn_count" -eq 0 ]; then
      ok "$svc — clean (no errors or warnings)"
    else
      if [ "$err_count" -gt 0 ]; then
        err "$svc — $err_count ERROR(s), $wrn_count WARN(s)"
        LOG_ERRORS=$((LOG_ERRORS + 1))
      else
        warn "$svc — $wrn_count WARN(s)"
      fi

      hdr "Matches"
      while IFS= read -r line; do
        [ -z "$line" ] && continue
        if echo "$line" | grep -q ' ERROR '; then
          echo -e "    ${RED}${line}${RST}"
        else
          echo -e "    ${YEL}${line}${RST}"
        fi
      done <<< "$matches"
    fi
  done
}

# ── 2. Health Check ────────────────────────────────────────────────────────────

run_health_check() {
  section "Actuator Health"

  for svc in "${SERVICES[@]}"; do
    port="${PORTS[$svc]}"
    resp=$(curl -s --max-time 3 "http://localhost:$port/actuator/health" 2>/dev/null || true)

    if [ -z "$resp" ]; then
      err "$svc (port $port) — UNREACHABLE"
    else
      status=$(echo "$resp" | grep -o '"status":"[^"]*"' | head -1 | cut -d'"' -f4 || echo "UNKNOWN")
      case "$status" in
        UP)    ok   "$svc (port $port) — $status" ;;
        *)     warn "$svc (port $port) — $status" ;;
      esac
    fi
  done
}

# ── Summary ────────────────────────────────────────────────────────────────────

print_summary() {
  section "Summary"
  if [ "$LOG_ERRORS" -eq 0 ]; then
    ok "No errors found"
  else
    err "$LOG_ERRORS service(s) have ERROR entries in logs"
  fi
  echo ""
}

# ── Entry Point ────────────────────────────────────────────────────────────────

run_log_check
run_health_check
print_summary
