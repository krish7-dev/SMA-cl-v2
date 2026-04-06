#!/usr/bin/env bash
# deploy.sh — Upload built JARs to EC2
# Usage:
#   ./deploy.sh           — upload all 4 services
#   ./deploy.sh broker    — upload only broker
#   ./deploy.sh data strategy — upload data + strategy

set -e

PEM="G:/AWS/sma-key.pem"
HOST="ubuntu@13.63.53.146"
BASE="G:/SMA-claude-v2"

declare -A JARS=(
  [broker]="SMA-Broker-Engine/target/sma-broker-engine-0.0.1-SNAPSHOT.jar:app/broker/sma-broker-engine-0.0.1-SNAPSHOT.jar"
  [execution]="SMA-Execution-Engine/target/sma-execution-engine-0.0.1-SNAPSHOT.jar:app/execution/sma-execution-engine-0.0.1-SNAPSHOT.jar"
  [data]="SMA-Data-Engine/target/sma-data-engine-0.0.1-SNAPSHOT.jar:app/data/sma-data-engine-0.0.1-SNAPSHOT.jar"
  [strategy]="SMA-Strategy-Engine/target/sma-strategy-engine-0.0.1-SNAPSHOT.jar:app/strategy/sma-strategy-engine-0.0.1-SNAPSHOT.jar"
)

# Determine which services to deploy
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

  local_path="$BASE/${JARS[$svc]%%:*}"
  remote_path="${JARS[$svc]##*:}"

  if [ ! -f "$local_path" ]; then
    echo "JAR not found: $local_path — run mvn clean package -DskipTests first"
    exit 1
  fi

  echo "Uploading $svc..."
  scp -i "$PEM" "$local_path" "$HOST:~/$remote_path"
  echo "$svc uploaded."
done

echo "Done. Restart services on EC2 as needed."
