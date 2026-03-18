#!/bin/bash
# Run as root or with sudo
sudo -u postgres psql << 'EOF'
CREATE USER docnet WITH PASSWORD 'CHANGE_THIS_PASSWORD';
CREATE DATABASE docnet OWNER docnet;
GRANT ALL PRIVILEGES ON DATABASE docnet TO docnet;
\c docnet
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
EOF
echo "PostgreSQL setup complete."
