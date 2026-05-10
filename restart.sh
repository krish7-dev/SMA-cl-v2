#!/usr/bin/env bash
# restart.sh — Restart one or more SMA services on EC2
# Upload this to EC2: scp -i "G:/AWS/sma-key.pem" restart.sh ubuntu@16.16.206.197:~/restart.sh
# Usage:
#   ./restart.sh              — restart all 4 services in order
#   ./restart.sh data         — restart only data engine
#   ./restart.sh data strategy — restart data then strategy

set -e

declare -A JARS=(
  [broker]="sma-broker-engine-0.0.1-SNAPSHOT.jar"
  [execution]="sma-execution-engine-0.0.1-SNAPSHOT.jar"
  [data]="sma-data-engine-0.0.1-SNAPSHOT.jar"
  [strategy]="sma-strategy-engine-0.0.1-SNAPSHOT.jar"
  [ai]="sma-ai-engine-0.0.1-SNAPSHOT.jar"
)

declare -A JVMOPTS=(
  [broker]=""
  [execution]=""
  [data]=""
  [strategy]="-Xmx3g -XX:MaxHeapFreeRatio=30 -XX:MinHeapFreeRatio=10"
  [ai]=""
)

declare -A ENVS=(
  [broker]="broker.env"
  [execution]="execution.env"
  [data]="data.env"
  [strategy]="strategy.env"
  [ai]="ai.env"
)

declare -A PORTS=(
  [broker]=9003
  [execution]=9004
  [data]=9005
  [strategy]=9006
  [ai]=9007
)

restart_service() {
  local svc=$1
  local jar="${JARS[$svc]}"
  local env="${ENVS[$svc]}"
  local port="${PORTS[$svc]}"

  local jar_path=~/app/$svc/$jar
  local build_time=$(TZ='Asia/Kolkata' date -d "$(stat -c '%y' "$jar_path" 2>/dev/null)" '+%Y-%m-%d %H:%M:%S IST' 2>/dev/null || echo "unknown")
  echo "--- [$svc] JAR last modified: $build_time"

  echo "--- Stopping $svc..."
  pkill -f "$jar" 2>/dev/null || true
  sleep 2

  echo "--- Starting $svc (port $port)..."
  set -a; source ~/env/$env; set +a
  nohup java ${JVMOPTS[$svc]} -jar ~/app/$svc/$jar > ~/logs/$svc.log 2>&1 &

  echo "--- Waiting for $svc to be healthy..."
  for i in $(seq 1 30); do
    sleep 3
    status=$(curl -s http://localhost:$port/actuator/health | grep -o '"status":"[^"]*"' | head -1)
    if echo "$status" | grep -q "UP"; then
      echo "--- $svc is UP"
      break
    fi
    if [ $i -eq 30 ]; then
      echo "--- WARNING: $svc did not become healthy in 90s, check ~/logs/$svc.log"
    fi
  done
}

if [ $# -eq 0 ]; then
  SERVICES=("broker" "data" "execution" "strategy" "ai")
else
  SERVICES=("$@")
fi

for svc in "${SERVICES[@]}"; do
  if [ -z "${JARS[$svc]}" ]; then
    echo "Unknown service: $svc (valid: broker, execution, data, strategy, ai)"
    exit 1
  fi
  restart_service "$svc"
done

echo ""
echo "=== Final health check ==="
for svc in "${SERVICES[@]}"; do
  port="${PORTS[$svc]}"
  result=$(curl -s http://localhost:$port/actuator/health | grep -o '"status":"[^"]*"' | head -1 || echo '"status":"UNREACHABLE"')
  echo "$svc (port $port): $result"
done
