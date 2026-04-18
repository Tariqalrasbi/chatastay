#!/usr/bin/env bash
# Daily SQLite backup + 14-day retention. Intended for cron (e.g. 03:15 UTC).
# Logs append to $CHATASTAY_ROOT/logs/backup.log
#
# Optional: set RUN_BACKUP_UPLOAD_S3=1 to also run npm run backup:upload:s3 after backup.

set -euo pipefail

ROOT="${CHATASTAY_ROOT:-/var/www/chatastay}"
LOG_DIR="${ROOT}/logs"
LOG_FILE="${LOG_DIR}/backup.log"
BACKUP_DIR="${ROOT}/backups/sqlite"

mkdir -p "${LOG_DIR}" "${BACKUP_DIR}"

exec >>"${LOG_FILE}" 2>&1

echo "=== $(date -u +"%Y-%m-%dT%H:%M:%SZ") backup start (ROOT=${ROOT}) ==="
cd "${ROOT}"

if ! command -v npm >/dev/null 2>&1; then
  echo "ERROR: npm not in PATH for cron. Use full path or source profile."
  exit 1
fi

npm run backup:db

echo "Retention: deleting chatastay backup files older than 14 days under ${BACKUP_DIR}"
find "${BACKUP_DIR}" -maxdepth 1 -type f \( -name 'chatastay-*.db' -o -name 'chatastay-*.db-wal' -o -name 'chatastay-*.db-shm' \) -mtime +14 -print -delete || true

if [ "${RUN_BACKUP_UPLOAD_S3:-0}" = "1" ]; then
  echo "Optional S3 upload (RUN_BACKUP_UPLOAD_S3=1)"
  npm run backup:upload:s3 || echo "WARN: backup:upload:s3 failed (non-fatal for local backup)"
fi

echo "=== $(date -u +"%Y-%m-%dT%H:%M:%SZ") backup end ==="
