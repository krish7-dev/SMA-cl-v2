#!/usr/bin/env bash
# stop.sh — Stop one or more SMA services on EC2
# Usage:
#   ./stop.sh              — stop all 4 services
#   ./stop.sh data         — stop only data engine
#   ./stop.sh data strategy — stop data then strategy

declare -A JARS=(
  [broker]="sma-broker-engine-0.0.1-SNAPSHOT.jar"
  [execution]="sma-execution-engine-0.0.1-SNAPSHOT.jar"
  [data]="sma-data-engine-0.0.1-SNAPSHOT.jar"
  [strategy]="sma-strategy-engine-0.0.1-SNAPSHOT.jar"
)

if [ $# -eq 0 ]; then
  SERVICES=("broker" "execution" "data" "strategy")
else
  SERVICES=("$@")
fi

for svc in "${SERVICES[@]}"; do
  if [ -z "${JARS[$svc]}" ]; then
    echo "Unknown service: $svc (valid: broker, execution, data, strategy)"
    exit 1
  fi

  jar="${JARS[$svc]}"
  pid=$(pgrep -f "$jar" || true)

  if [ -z "$pid" ]; then
    echo "[$svc] not running"
  else
    kill "$pid"
    echo "[$svc] stopped (pid $pid)"
  fi
done
