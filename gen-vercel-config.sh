#!/usr/bin/env bash
# gen-vercel-config.sh — Regenerates SMA-UI/vercel.json from ec2.conf
# Run this whenever EC2_IP changes, then redeploy to Vercel.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/ec2.conf"

cat > "$SCRIPT_DIR/SMA-UI/vercel.json" <<EOF
{
  "rewrites": [
    { "source": "/api/broker/:path*",    "destination": "http://$EC2_IP:9003/:path*" },
    { "source": "/api/execution/:path*", "destination": "http://$EC2_IP:9004/:path*" },
    { "source": "/api/data/:path*",      "destination": "http://$EC2_IP:9005/:path*" },
    { "source": "/api/strategy/:path*",  "destination": "http://$EC2_IP:9006/:path*" },
    { "source": "/(.*)",                 "destination": "/index.html" }
  ]
}
EOF

echo "vercel.json updated with EC2_IP=$EC2_IP"
