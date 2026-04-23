#!/usr/bin/env bash
# monitor.sh — System resource and service health monitor
# Upload: scp -i "G:/AWS/sma-key.pem" monitor.sh ubuntu@16.16.119.222:~/monitor.sh && ssh -i "G:/AWS/sma-key.pem" ubuntu@16.16.119.222 "chmod +x ~/monitor.sh"
# Run manually: bash monitor.sh

RED='\033[0;31m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

declare -A JARS=(
  [broker]="sma-broker-engine-0.0.1-SNAPSHOT.jar"
  [execution]="sma-execution-engine-0.0.1-SNAPSHOT.jar"
  [data]="sma-data-engine-0.0.1-SNAPSHOT.jar"
  [strategy]="sma-strategy-engine-0.0.1-SNAPSHOT.jar"
)

declare -A PORTS=(
  [broker]=9003
  [execution]=9004
  [data]=9005
  [strategy]=9006
)

SERVICES=("broker" "execution" "data" "strategy")

divider() { echo "══════════════════════════════════════"; }

# ── System RAM ──────────────────────────────────────────────────
divider
echo -e "  ${BOLD}System Memory${NC}"
divider

read total used free shared cache available <<< $(free -m | awk '/^Mem:/ {print $2, $3, $4, $5, $6, $7}')
pct_used=$(( used * 100 / total ))

if   [ $pct_used -ge 90 ]; then color=$RED;    label="CRITICAL"
elif [ $pct_used -ge 75 ]; then color=$YELLOW; label="WARNING"
else                             color=$GREEN;  label="OK"
fi

printf "  RAM : %dMi total  |  %dMi used  |  %dMi available  |  " $total $used $available
echo -e "${color}${pct_used}% — ${label}${NC}"

read swap_total swap_used _ <<< $(free -m | awk '/^Swap:/ {print $2, $3, $4}')
if [ "$swap_total" -eq 0 ]; then
  echo -e "  Swap: ${YELLOW}NONE — no swap configured (OOM risk)${NC}"
else
  echo -e "  Swap: ${swap_used}Mi used / ${swap_total}Mi total"
fi

# ── Load Average ────────────────────────────────────────────────
load=$(cat /proc/loadavg | awk '{print $1, $2, $3}')
cpu_count=$(nproc)
echo -e "  Load: $load (1m 5m 15m) | CPUs: $cpu_count"

# ── Disk ────────────────────────────────────────────────────────
disk=$(df -h / | awk 'NR==2 {printf "%s used / %s total (%s)", $3, $2, $5}')
disk_pct=$(df / | awk 'NR==2 {gsub(/%/,"",$5); print $5}')
if [ $disk_pct -ge 85 ]; then disk_color=$RED
elif [ $disk_pct -ge 70 ]; then disk_color=$YELLOW
else disk_color=$GREEN; fi
echo -e "  Disk: ${disk_color}${disk}${NC}"

# ── Per-Service Memory & Status ─────────────────────────────────
echo ""
divider
echo -e "  ${BOLD}Service Status & Memory${NC}"
divider

any_down=false
for svc in "${SERVICES[@]}"; do
  jar="${JARS[$svc]}"
  port="${PORTS[$svc]}"

  pid=$(pgrep -f "$jar" 2>/dev/null | head -1)

  if [ -z "$pid" ]; then
    echo -e "  ${RED}✘  $svc${NC}  —  ${RED}NOT RUNNING${NC}"
    any_down=true
    continue
  fi

  # Memory from /proc (RSS in KB → MB)
  rss_kb=$(cat /proc/$pid/status 2>/dev/null | awk '/^VmRSS:/ {print $2}')
  rss_mb=$(( ${rss_kb:-0} / 1024 ))
  vsz_kb=$(cat /proc/$pid/status 2>/dev/null | awk '/^VmSize:/ {print $2}')
  vsz_mb=$(( ${vsz_kb:-0} / 1024 ))

  if   [ $rss_mb -ge 700 ]; then mem_color=$RED;    mem_label="HIGH"
  elif [ $rss_mb -ge 500 ]; then mem_color=$YELLOW; mem_label="WARN"
  else                           mem_color=$GREEN;  mem_label="OK"
  fi

  # Actuator health
  health=$(curl -s --max-time 3 http://localhost:$port/actuator/health | grep -o '"status":"[^"]*"' | head -1)
  if echo "$health" | grep -q "UP"; then
    health_str="${GREEN}UP${NC}"
  else
    health_str="${RED}UNREACHABLE${NC}"
  fi

  printf "  ${GREEN}✔${NC}  %-12s  pid %-6s  RAM: ${mem_color}%dMi${NC} (%s)  VSZ: %dMi  health: " \
    "$svc" "$pid" "$rss_mb" "$mem_label" "$vsz_mb"
  echo -e "$health_str"
done

# ── DB Connection Pools ──────────────────────────────────────────
echo ""
divider
echo -e "  ${BOLD}DB Connection Pools (HikariCP)${NC}"
divider

get_metric() {
  local port=$1 metric=$2
  curl -s --max-time 3 "http://localhost:$port/actuator/metrics/$metric" \
    | grep -o '"value":[0-9.]*' | head -1 | cut -d: -f2
}

total_active=0
total_pending=0
any_pool_warn=false

for svc in "${SERVICES[@]}"; do
  port="${PORTS[$svc]}"
  pid=$(pgrep -f "${JARS[$svc]}" 2>/dev/null | head -1)
  [ -z "$pid" ] && continue

  active=$(get_metric  $port "hikaricp.connections.active")
  idle=$(get_metric    $port "hikaricp.connections.idle")
  pending=$(get_metric $port "hikaricp.connections.pending")
  timeouts=$(get_metric $port "hikaricp.connections.timeout.total")
  max=$(get_metric     $port "hikaricp.connections.max")

  active=${active:-?}; idle=${idle:-?}; pending=${pending:-?}
  timeouts=${timeouts:-?}; max=${max:-?}

  # Colour pending: >0 = yellow warning, timeouts >0 = red
  if [ "$timeouts" != "?" ] && [ "${timeouts%.*}" -gt 0 ] 2>/dev/null; then
    pool_color=$RED; pool_label="TIMEOUT"; any_pool_warn=true
  elif [ "$pending" != "?" ] && [ "${pending%.*}" -gt 0 ] 2>/dev/null; then
    pool_color=$YELLOW; pool_label="WAITING"; any_pool_warn=true
  else
    pool_color=$GREEN; pool_label="OK"
  fi

  [ "$active"  != "?" ] && total_active=$(( total_active  + ${active%.*}  ))
  [ "$pending" != "?" ] && total_pending=$(( total_pending + ${pending%.*} ))

  printf "  %-12s  active: %s/%s  idle: %s  pending: %s  timeouts: %s  " \
    "$svc" "$active" "$max" "$idle" "$pending" "$timeouts"
  echo -e "${pool_color}${pool_label}${NC}"
done

echo -e "  ─────────────────────────────────────"
echo -e "  Total active connections across all services: ${BOLD}${total_active}${NC}  |  pending: ${BOLD}${total_pending}${NC}"
if [ "$any_pool_warn" = true ]; then
  echo -e "  ${YELLOW}⚠  DB pool pressure detected — check Supabase dashboard${NC}"
fi

# ── Recent Errors ────────────────────────────────────────────────
echo ""
divider
echo -e "  ${BOLD}Recent Errors (last 200 lines per service)${NC}"
divider

any_errors=false
for svc in "${SERVICES[@]}"; do
  log=~/logs/$svc.log
  [ ! -f "$log" ] && continue

  errors=$(tail -200 "$log" | grep "ERROR")
  if [ -n "$errors" ]; then
    any_errors=true
    echo -e "  ${RED}[$svc]${NC}"
    echo "$errors" | tail -5 | while IFS= read -r line; do
      echo "    $line"
    done
  fi
done

if [ "$any_errors" = false ]; then
  echo -e "  ${GREEN}No errors in recent logs${NC}"
fi

# ── Summary ──────────────────────────────────────────────────────
echo ""
divider
echo -e "  ${BOLD}Summary${NC}"
divider

if [ "$any_down" = true ]; then
  echo -e "  ${RED}✘  One or more services are DOWN — run: bash restart.sh${NC}"
else
  echo -e "  ${GREEN}✔  All services running${NC}"
fi

if [ $pct_used -ge 75 ]; then
  echo -e "  ${YELLOW}⚠  RAM at ${pct_used}% — monitor closely${NC}"
fi

if [ $pct_used -ge 90 ]; then
  echo -e "  ${RED}✘  RAM CRITICAL — restart services or reboot soon${NC}"
fi

if [ "$any_pool_warn" = true ]; then
  echo -e "  ${YELLOW}⚠  DB pool pressure — pending connections waiting, watch for timeouts${NC}"
fi

echo ""
echo -e "  Checked at: $(TZ='Asia/Kolkata' date '+%Y-%m-%d %H:%M:%S IST')"
divider
