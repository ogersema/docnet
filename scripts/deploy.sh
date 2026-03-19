#!/bin/bash
set -e

VPS_HOST="46.225.48.50"
VPS_USER="root"
APP_DIR="/root/docnet"
DIST_DIR="/var/docnet/dist"

echo "=== Building frontend locally ==="
cd "$(dirname "$0")/.."
cd network-ui
npm run build
cd ..

echo "=== Syncing code to VPS ==="
rsync -avz --delete \
  --exclude='.git' \
  --exclude='.claude' \
  --exclude='node_modules' \
  --exclude='network-ui/node_modules' \
  --exclude='uploads' \
  --exclude='upload/*.pdf' \
  --exclude='upload/*.xlsx' \
  --exclude='storage/*.db' \
  --exclude='*.db' \
  --exclude='.env' \
  --exclude='docnet.config.json' \
  . ${VPS_USER}@${VPS_HOST}:${APP_DIR}/

echo "=== Syncing frontend dist ==="
rsync -avz network-ui/dist/ ${VPS_USER}@${VPS_HOST}:${DIST_DIR}/

echo "=== Installing dependencies on VPS ==="
ssh ${VPS_USER}@${VPS_HOST} "cd ${APP_DIR} && npm install --production"

echo "=== Running database migrations ==="
ssh ${VPS_USER}@${VPS_HOST} "cd ${APP_DIR} && tsx db/migrate.ts"

echo "=== Restarting services ==="
ssh ${VPS_USER}@${VPS_HOST} "pm2 reload docnet-api docnet-worker"

echo "=== Deploy complete ==="
echo "Live at: https://docnet.46.225.48.50.sslip.io"
echo "Check status: ssh ${VPS_USER}@${VPS_HOST} 'pm2 status'"
