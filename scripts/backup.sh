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
