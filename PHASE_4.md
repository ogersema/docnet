# Phase 4 – Hetzner Deployment
## nginx · PM2 · TLS · PostgreSQL · Production Hardening

Prerequisite: Phases 1–3 complete and verified locally.

**Deliverable:** The application runs on your Hetzner VPS at a fixed domain
(e.g. `recherche.euer-verlag.de`), with HTTPS, automatic restarts, and a
clean deployment workflow.

**Assumptions:**
- Hetzner VPS running Ubuntu 22.04 LTS (or 24.04)
- A domain name pointing to the VPS IP (DNS A record set up)
- SSH access to the VPS
- You have sudo rights on the VPS

---

## Step 4.1 — VPS Initial Setup

Run on the VPS as root (or with sudo):

```bash
# Update system
apt update && apt upgrade -y

# Install Node.js 20 LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs

# Install PostgreSQL 16
apt install -y postgresql postgresql-contrib

# Install nginx
apt install -y nginx

# Install certbot for Let's Encrypt
apt install -y certbot python3-certbot-nginx

# Install git and PM2
npm install -g pm2 tsx

# Create docnet system user (no login shell)
useradd --system --create-home --shell /bin/bash docnet

# Create directories
mkdir -p /var/docnet/uploads
mkdir -p /var/docnet/dist
mkdir -p /var/log/docnet
chown -R docnet:docnet /var/docnet /var/log/docnet
```

---

## Step 4.2 — PostgreSQL Setup

```bash
# As postgres user
sudo -u postgres psql << 'EOF'
CREATE USER docnet WITH PASSWORD 'REPLACE_WITH_STRONG_PASSWORD';
CREATE DATABASE docnet OWNER docnet;
GRANT ALL PRIVILEGES ON DATABASE docnet TO docnet;
\c docnet
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
EOF

# Test connection
sudo -u docnet psql postgresql://docnet:PASSWORD@localhost/docnet -c '\l'
```

---

## Step 4.3 — Deploy Application Code

Create the deployment script `scripts/deploy.sh` (run from your local machine):

```bash
#!/bin/bash
set -e

VPS_HOST="your-vps-ip-or-domain"
VPS_USER="docnet"
APP_DIR="/home/docnet/app"
DIST_DIR="/var/docnet/dist"

echo "=== Building frontend locally ==="
cd network-ui
npm run build
cd ..

echo "=== Syncing code to VPS ==="
rsync -avz --delete \
  --exclude='.git' \
  --exclude='node_modules' \
  --exclude='network-ui/node_modules' \
  --exclude='network-ui/dist' \
  --exclude='uploads' \
  --exclude='*.db' \
  --exclude='.env' \
  . ${VPS_USER}@${VPS_HOST}:${APP_DIR}/

echo "=== Syncing frontend dist ==="
rsync -avz network-ui/dist/ ${VPS_USER}@${VPS_HOST}:${DIST_DIR}/

echo "=== Installing dependencies on VPS ==="
ssh ${VPS_USER}@${VPS_HOST} "cd ${APP_DIR} && npm install --production"

echo "=== Running database migrations ==="
ssh ${VPS_USER}@${VPS_HOST} "cd ${APP_DIR} && npx tsx db/migrate.ts"

echo "=== Restarting services ==="
ssh ${VPS_USER}@${VPS_HOST} "pm2 reload docnet-api docnet-worker"

echo "=== Deploy complete ==="
```

Make it executable: `chmod +x scripts/deploy.sh`

---

## Step 4.4 — Environment Variables on VPS

Create `/home/docnet/app/.env` on the VPS (never commit this to git):

```bash
# Create and edit securely
sudo -u docnet nano /home/docnet/app/.env
```

Contents:
```bash
NODE_ENV=production
PORT=3001
DATABASE_URL=postgresql://docnet:STRONG_PASSWORD@localhost:5432/docnet
JWT_SECRET=GENERATE_WITH: node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
ANTHROPIC_API_KEY=sk-ant-YOUR_KEY_HERE
UPLOAD_DIR=/var/docnet/uploads
DIST_DIR=/var/docnet/dist
ERROR_LOG=/var/log/docnet/error.log
ACCESS_LOG=/var/log/docnet/access.log
```

Permissions (only docnet user can read):
```bash
chown docnet:docnet /home/docnet/app/.env
chmod 600 /home/docnet/app/.env
```

---

## Step 4.5 — PM2 Configuration

Create `pm2.config.js` in the project root:

```javascript
module.exports = {
  apps: [
    {
      name: 'docnet-api',
      script: 'tsx',
      args: 'api_server.ts',
      cwd: '/home/docnet/app',
      user: 'docnet',
      env_file: '/home/docnet/app/.env',
      instances: 1,           // single instance (DB connection pooling)
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      error_file: '/var/log/docnet/api-error.log',
      out_file: '/var/log/docnet/api-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      restart_delay: 3000,
    },
    {
      name: 'docnet-worker',
      script: 'tsx',
      args: 'worker/index.ts',
      cwd: '/home/docnet/app',
      user: 'docnet',
      env_file: '/home/docnet/app/.env',
      instances: 1,           // single worker (serialize analysis jobs)
      autorestart: true,
      watch: false,
      max_memory_restart: '2G',  // worker uses more memory (Playwright)
      error_file: '/var/log/docnet/worker-error.log',
      out_file: '/var/log/docnet/worker-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      restart_delay: 5000,
    }
  ]
};
```

First start on VPS:
```bash
sudo -u docnet bash -c "cd /home/docnet/app && pm2 start pm2.config.js"
pm2 save                    # Persist across reboots
pm2 startup systemd         # Enable PM2 on boot
# Run the printed command (it's different per system)
```

---

## Step 4.6 — nginx Configuration

Create `/etc/nginx/sites-available/docnet`:

```nginx
server {
    listen 80;
    server_name YOUR_DOMAIN.com www.YOUR_DOMAIN.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name YOUR_DOMAIN.com www.YOUR_DOMAIN.com;

    # TLS — certbot will fill these in automatically
    ssl_certificate /etc/letsencrypt/live/YOUR_DOMAIN.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/YOUR_DOMAIN.com/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    # Security headers
    add_header X-Frame-Options DENY;
    add_header X-Content-Type-Options nosniff;
    add_header X-XSS-Protection "1; mode=block";
    add_header Referrer-Policy strict-origin-when-cross-origin;

    # File upload size limit (match multer's 50MB per file)
    client_max_body_size 200M;

    # API proxy
    location /api/ {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        proxy_read_timeout 120s;   # Allow long-running analysis requests
    }

    # Static frontend
    location / {
        root /var/docnet/dist;
        try_files $uri $uri/ /index.html;   # SPA fallback
        
        # Cache static assets aggressively
        location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff2)$ {
            expires 1y;
            add_header Cache-Control "public, immutable";
        }
    }
}
```

Enable and test:
```bash
ln -s /etc/nginx/sites-available/docnet /etc/nginx/sites-enabled/
nginx -t                    # Test config — must say "syntax is ok"
systemctl reload nginx
```

---

## Step 4.7 — TLS Certificate

```bash
# Get Let's Encrypt certificate
certbot --nginx -d YOUR_DOMAIN.com -d www.YOUR_DOMAIN.com

# Test renewal works
certbot renew --dry-run

# Auto-renewal is already set up by certbot via systemd timer
# Verify: systemctl status certbot.timer
```

---

## Step 4.8 — Firewall

```bash
# UFW firewall rules
ufw allow OpenSSH      # Keep SSH access!
ufw allow 'Nginx Full' # Allow HTTP + HTTPS
ufw enable

# Verify
ufw status
# Should show: 22, 80, 443 open; 3001 NOT open (only nginx accesses it)
```

Port 3001 (Express) must **not** be publicly accessible — only nginx proxies to it.

---

## Step 4.9 — Production Code Changes

These small code changes are needed specifically for production:

### Add dotenv loading to api_server.ts and worker/index.ts

At the very top of both files (before any other imports):
```typescript
import dotenv from 'dotenv';
dotenv.config(); // Loads .env file in development; in production .env is set via pm2.config.js env_file
```

```bash
npm install dotenv @types/dotenv
```

### Add request logging middleware to api_server.ts

```typescript
import morgan from 'morgan';
import fs from 'fs';

// npm install morgan @types/morgan

const accessLogStream = process.env.ACCESS_LOG
  ? fs.createWriteStream(process.env.ACCESS_LOG, { flags: 'a' })
  : undefined;

app.use(morgan('combined', { stream: accessLogStream }));
```

### Harden error responses in production

In all route error handlers, don't send internal error details to clients:

```typescript
// Pattern to use everywhere:
} catch (err: any) {
  if (process.env.NODE_ENV === 'production') {
    console.error(err); // Goes to PM2 log
    res.status(500).json({ error: 'Internal server error' });
  } else {
    res.status(500).json({ error: err.message, stack: err.stack });
  }
}
```

### Health check endpoint (already in api_server.ts, verify it exists)

```typescript
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() });
});
```

nginx can use this for monitoring.

---

## Step 4.10 — Log Rotation

Create `/etc/logrotate.d/docnet`:

```
/var/log/docnet/*.log {
    daily
    rotate 14
    compress
    delaycompress
    missingok
    notifempty
    sharedscripts
    postrotate
        pm2 reloadLogs
    endscript
}
```

---

## Step 4.11 — Backup Strategy

Create `scripts/backup.sh` (run via cron on VPS):

```bash
#!/bin/bash
BACKUP_DIR="/var/backups/docnet"
DATE=$(date +%Y%m%d_%H%M%S)

mkdir -p "$BACKUP_DIR"

# Dump PostgreSQL
PGPASSWORD="$DB_PASSWORD" pg_dump \
  -U docnet \
  -h localhost \
  docnet \
  | gzip > "$BACKUP_DIR/db_${DATE}.sql.gz"

# Backup uploads directory
tar -czf "$BACKUP_DIR/uploads_${DATE}.tar.gz" /var/docnet/uploads/

# Keep only last 7 daily backups
find "$BACKUP_DIR" -name "*.gz" -mtime +7 -delete

echo "Backup complete: ${DATE}"
```

Add to cron (`crontab -e` as root):
```
0 3 * * * DB_PASSWORD=YOUR_PASSWORD /home/docnet/app/scripts/backup.sh >> /var/log/docnet/backup.log 2>&1
```

---

## Step 4.12 — First Admin User

After deployment, create the first admin user directly in the database:

```bash
sudo -u postgres psql docnet << 'EOF'
-- After running migrations, create first admin
-- The password hash below is bcrypt of "change-me-immediately"
-- Replace with a proper hash generated by: node -e "require('bcrypt').hash('your-password', 12).then(console.log)"
UPDATE users SET role = 'admin' WHERE email = 'your@email.com';
EOF
```

Or just register through the web UI (first user registers normally,
then promote via SQL).

---

## Phase 4 Verification Checklist

- [ ] VPS has Node.js 20, PostgreSQL 16, nginx, PM2 installed
- [ ] PostgreSQL `docnet` database and user created
- [ ] `.env` file on VPS with all required variables, permissions 600
- [ ] `pm2 start pm2.config.js` starts both `docnet-api` and `docnet-worker`
- [ ] `pm2 status` shows both processes as "online"
- [ ] `curl http://localhost:3001/api/health` returns `{ status: 'ok' }` from VPS
- [ ] nginx config passes `nginx -t` test
- [ ] `https://YOUR_DOMAIN.com` loads the login page in browser
- [ ] `http://YOUR_DOMAIN.com` redirects to `https://`
- [ ] SSL certificate is valid (green padlock in browser)
- [ ] Register a new user via the web UI → works
- [ ] Login → project list shows → open project → graph page loads
- [ ] Upload a PDF → worker processes it → graph populates
- [ ] Submit a URL → crawl runs → web documents appear in graph
- [ ] Direct port access `http://YOUR_VPS_IP:3001` is blocked by firewall
- [ ] `pm2 startup` configured — reboot VPS and verify services restart automatically
- [ ] Log rotation configured and `/var/log/docnet/` is writing logs
- [ ] Backup script runs without errors
- [ ] `certbot renew --dry-run` succeeds

---

## Ongoing Deployment Workflow

For future updates, just run from your local machine:

```bash
./scripts/deploy.sh
```

This:
1. Builds the React frontend locally
2. `rsync`s code to the VPS (fast, only changed files)
3. Installs any new npm packages
4. Runs any pending database migrations
5. Reloads PM2 processes (zero-downtime reload)

Total time for a typical code change: ~30 seconds.
