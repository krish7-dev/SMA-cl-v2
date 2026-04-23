#!/usr/bin/env bash
# stop.sh — Stop one or more SMA services (local or EC2)
# Usage:
#   ./stop.sh              — stop all 4 services
#   ./stop.sh data         — stop only data engine
#   ./stop.sh data strategy — stop data then strategy

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOGS_DIR="$SCRIPT_DIR/logs"

if [ $# -eq 0 ]; then
  SERVICES=("broker" "execution" "data" "strategy")
else
  SERVICES=("$@")
fi

for svc in "${SERVICES[@]}"; do
  case "$svc" in
    broker|execution|data|strategy) ;;
    *) echo "Unknown service: $svc (valid: broker, execution, data, strategy)"; exit 1 ;;
  esac

  pid_file="$LOGS_DIR/$svc.pid"
  if [ -f "$pid_file" ]; then
    pid=$(cat "$pid_file")
    if kill "$pid" 2>/dev/null; then
      echo "[$svc] stopped (pid $pid)"
    else
      echo "[$svc] not running (stale pid $pid)"
    fi
    rm -f "$pid_file"
  else
    echo "[$svc] not running (no pid file)"
  fi
done
