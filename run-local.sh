#!/usr/bin/env bash
# run-local.sh — Run SMA services locally using .env files from each service directory
# Usage:
#   ./run-local.sh              — start all 4 services in order
#   ./run-local.sh data         — start only data engine
#   ./run-local.sh data strategy — start data then strategy
#
# Prerequisites: JARs must be built first.
# Build all:
#   mvn -f SMA-Broker-Engine/pom.xml package -DskipTests
#   mvn -f SMA-Execution-Engine/pom.xml package -DskipTests
#   mvn -f SMA-Data-Engine/pom.xml package -DskipTests
#   mvn -f SMA-Strategy-Engine/pom.xml package -DskipTests

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOGS_DIR="$SCRIPT_DIR/logs"
mkdir -p "$LOGS_DIR"

declare -A JARS=(
  [broker]="SMA-Broker-Engine/target/sma-broker-engine-0.0.1-SNAPSHOT.jar"
  [execution]="SMA-Execution-Engine/target/sma-execution-engine-0.0.1-SNAPSHOT.jar"
  [data]="SMA-Data-Engine/target/sma-data-engine-0.0.1-SNAPSHOT.jar"
  [strategy]="SMA-Strategy-Engine/target/sma-strategy-engine-0.0.1-SNAPSHOT.jar"
)

declare -A ENVFILES=(
  [broker]="SMA-Broker-Engine/.env"
  [execution]="SMA-Execution-Engine/.env"
  [data]="SMA-Data-Engine/.env"
  [strategy]="SMA-Strategy-Engine/.env"
)

declare -A JVMOPTS=(
  [broker]=""
  [execution]=""
  [data]=""
  [strategy]="-Xmx3g"
)

declare -A PORTS=(
  [broker]=9003
  [execution]=9004
  [data]=9005
  [strategy]=9006
)

start_service() {
  local svc=$1
  local jar="$SCRIPT_DIR/${JARS[$svc]}"
  local envfile="$SCRIPT_DIR/${ENVFILES[$svc]}"
  local port="${PORTS[$svc]}"
  local logfile="$LOGS_DIR/$svc.log"

  if [ ! -f "$jar" ]; then
    echo "[$svc] JAR not found: $jar"
    echo "[$svc] Build it first: mvn -f ${JARS[$svc]%/target/*}/pom.xml package -DskipTests"
    exit 1
  fi

  if [ ! -f "$envfile" ]; then
    echo "[$svc] .env file not found: $envfile"
    exit 1
  fi

  # Stop any existing instance
  pkill -f "$(basename "$jar")" 2>/dev/null || true
  sleep 1

  echo "--- Starting $svc (port $port) → logs/$svc.log"
  # Export env vars from .env file (strips surrounding quotes from values)
  set -a
  # shellcheck source=/dev/null
  source "$envfile"
  set +a

  nohup java ${JVMOPTS[$svc]} -jar "$jar" > "$logfile" 2>&1 &
  echo "$!" > "$LOGS_DIR/$svc.pid"

  echo "--- Waiting for $svc to be healthy..."
  for i in $(seq 1 30); do
    sleep 3
    if curl -s "http://localhost:$port/actuator/health" 2>/dev/null | grep -q '"status":"UP"'; then
      echo "--- [$svc] UP on port $port"
      break
    fi
    if [ "$i" -eq 30 ]; then
      echo "--- WARNING: $svc did not become healthy in 90s. Check logs/$svc.log"
    fi
  done
}

if [ $# -eq 0 ]; then
  SERVICES=("broker" "execution" "data" "strategy")
else
  SERVICES=("$@")
fi

for svc in "${SERVICES[@]}"; do
  if [ -z "${JARS[$svc]+x}" ]; then
    echo "Unknown service: $svc (valid: broker, execution, data, strategy)"
    exit 1
  fi
  start_service "$svc"
done

echo ""
echo "=== Health check ==="
for svc in "${SERVICES[@]}"; do
  port="${PORTS[$svc]}"
  result=$(curl -s "http://localhost:$port/actuator/health" | grep -o '"status":"[^"]*"' | head -1 || echo '"status":"UNREACHABLE"')
  echo "  $svc (port $port): $result"
done

echo ""
echo "Logs: $LOGS_DIR/"
echo "Stop: ./stop.sh (or kill by PID from logs/*.pid)"
