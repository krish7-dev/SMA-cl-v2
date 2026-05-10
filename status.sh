#!/usr/bin/env bash
# status.sh — Show JAR build times and service health
# Upload: scp -i "G:/AWS/sma-key.pem" status.sh ubuntu@16.16.206.197:~/status.sh && ssh -i "G:/AWS/sma-key.pem" ubuntu@16.16.206.197 "chmod +x ~/status.sh"

declare -A JARS=(
  [broker]="sma-broker-engine-0.0.1-SNAPSHOT.jar"
  [execution]="sma-execution-engine-0.0.1-SNAPSHOT.jar"
  [data]="sma-data-engine-0.0.1-SNAPSHOT.jar"
  [strategy]="sma-strategy-engine-0.0.1-SNAPSHOT.jar"
  [ai]="sma-ai-engine-0.0.1-SNAPSHOT.jar"
)

declare -A PORTS=(
  [broker]=9003
  [execution]=9004
  [data]=9005
  [strategy]=9006
  [ai]=9007
)

echo "=== Build Times ==="
for svc in broker execution data strategy ai; do
  jar_path=~/app/$svc/${JARS[$svc]}
  build_time=$(TZ='Asia/Kolkata' date -d "$(stat -c '%y' "$jar_path" 2>/dev/null)" '+%Y-%m-%d %H:%M:%S IST' 2>/dev/null || echo "JAR not found")
  printf "  %-12s %s\n" "$svc" "$build_time"
done

echo ""
echo "=== Service Health ==="
for svc in broker execution data strategy ai; do
  port="${PORTS[$svc]}"
  status=$(curl -s --max-time 3 http://localhost:$port/actuator/health | grep -o '"status":"[^"]*"' | head -1 || echo '"status":"UNREACHABLE"')
  printf "  %-12s port %s  %s\n" "$svc" "$port" "$status"
done
