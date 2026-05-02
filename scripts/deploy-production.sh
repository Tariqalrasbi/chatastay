#!/usr/bin/env bash
set -Eeuo pipefail

APP_NAME="${APP_NAME:-chatastay}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$ROOT_DIR"

log() {
  printf '\n[deploy-production] %s\n' "$*"
}

fail() {
  printf '\n[deploy-production] FAILED: %s\n' "$*" >&2
  exit 1
}

run() {
  log "$*"
  "$@"
}

verify_prisma_client() {
  npm run prisma:verify >/dev/null 2>&1
}

install_dependencies() {
  if [[ ! -f package-lock.json ]]; then
    fail "package-lock.json is required for a repeatable production install"
  fi

  if [[ ! -d node_modules ]]; then
    log "node_modules is missing; running clean npm ci"
    run npm ci --include=dev
    return
  fi

  if verify_prisma_client; then
    log "node_modules and generated Prisma client look usable; running safe npm install"
    run npm install --include=dev --no-audit --no-fund
    return
  fi

  log "Prisma client is missing or corrupted; removing node_modules before reinstall"
  run rm -rf node_modules
  run npm ci --include=dev
}

restart_pm2() {
  if pm2 describe "$APP_NAME" >/dev/null 2>&1; then
    run pm2 restart "$APP_NAME" --update-env
  else
    run pm2 start ecosystem.config.cjs --only "$APP_NAME" --update-env
  fi
  run pm2 save
}

main() {
  log "Starting guarded production deploy for $APP_NAME"
  log "PM2 will restart only after backup, install, Prisma, migrations, and build succeed."

  run npm run backup:db
  install_dependencies
  run npx prisma generate --schema=prisma/schema.prisma
  run npm run prisma:verify
  run npm run migrate:deploy
  run npm run build
  restart_pm2

  log "Deploy completed successfully."
}

main "$@"
