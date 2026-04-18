# SQLite backup and restore (ChatAstay)

This app uses **Prisma + SQLite**. The database file path comes from `DATABASE_URL` in `.env`. Relative `file:` URLs are resolved relative to the **`prisma/`** directory (same as Prisma), so `DATABASE_URL="file:./dev.db"` usually means:

`prisma/dev.db`

## Deploy safety (recommended order)

1. **Backup** (app may stay running for `sqlite3 .backup`; file-only copy is riskier under load):

   ```bash
   cd /var/www/chatastay && npm run backup:db
   ```

2. **Deploy** code (`git pull`, `npm ci` if needed, `npm run build`).

3. **Migrate** (only when you intend to apply schema changes):

   ```bash
   npm run migrate:deploy
   ```

4. **Restart** PM2:

   ```bash
   pm2 restart chatastay --update-env
   ```

Do **not** skip backups before migrations or risky file operations on the DB directory.

## Backup

- **Local / server:** `npm run backup:db`
- Writes timestamped files under `backups/sqlite/` (never overwrites: unique name per run).
- Prefers **`sqlite3` CLI** `.backup` (integrated snapshot, WAL merged into the copy).
- If `sqlite3` is missing, falls back to copying `*.db`, `*.db-wal`, `*.db-shm` next to the live file (documented limitation while the app writes).

Install SQLite CLI on Ubuntu if needed:

```bash
sudo apt-get update && sudo apt-get install -y sqlite3
```

## Restore (destructive to the **live** database)

**Stop the app first** so the DB file is not open:

```bash
pm2 stop chatastay
```

The restore script refuses to run without `--confirm-restore`. It runs **`npm run backup:db`** once automatically **before** overwriting (emergency snapshot of current live DB).

```bash
cd /var/www/chatastay
node scripts/restore-sqlite.cjs --from="/var/www/chatastay/backups/sqlite/chatastay-YOUR-TIMESTAMP.db" --confirm-restore
pm2 start chatastay
```

**Reversible vs irreversible**

- Restoring **replaces** the current live database content (after an automatic pre-restore backup).
- If you had **no backup** of an older state, recovery is **not** possible from this tooling alone.
- **Irreversible:** deleting or truncating tables without a copy; pointing `DATABASE_URL` at a new empty file; re-running `init` migrations on a fresh file while the old file still exists elsewhere (then you can still copy the old file back if it was not deleted).

## Finding older database files on the server (read-only)

Run **inspection only** (does not modify data):

```bash
cd /var/www/chatastay
find . -maxdepth 4 \( -name '*.db' -o -name '*.sqlite' -o -name '*.sqlite3' -o -name '*.db-wal' -o -name '*.db-shm' \) 2>/dev/null
ls -la prisma/*.db* 2>/dev/null
ls -la backups/sqlite/ 2>/dev/null
```

Compare **size** and **mtime**. A **live** DB is usually the path implied by `DATABASE_URL` and is non-trivial in size. **Zero-byte** files are not recoverable as databases.

To **inspect** a candidate file safely (read-only):

```bash
sqlite3 /path/to/candidate.db "PRAGMA integrity_check;"
sqlite3 /path/to/candidate.db "SELECT name FROM sqlite_master WHERE type='table' ORDER BY 1;"
```

To recover **without** the restore script: stop PM2, copy the chosen file **over** the live path (keep a manual copy of the current live file first), remove stale `-wal` / `-shm` siblings if present, start PM2. Prefer `restore-sqlite.cjs` because it runs an emergency backup first.

## Cron (optional)

Example daily backup at 03:15 (adjust paths/user):

```cron
15 3 * * * cd /var/www/chatastay && /usr/bin/npm run backup:db >> /var/log/chatastay-backup.log 2>&1
```

Ensure log rotation for `/var/log/chatastay-backup.log` if you use this.
