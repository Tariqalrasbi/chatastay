# SQLite backup, retention, S3 upload, and restore (production)

Paths assume production layout:

- App: `/var/www/chatastay`
- Live DB: `/var/www/chatastay/prisma/dev.db` (or whatever `DATABASE_URL` resolves to)
- Local backups: `/var/www/chatastay/backups/sqlite/`
- PM2 process name: `chatastay`

## Manual backup

```bash
cd /var/www/chatastay
npm run backup:db
```

Requires `sqlite3` on the server for a consistent snapshot (`apt-get install -y sqlite3`). Backups are never overwritten (unique filename per run).

## Manual restore (one command)

**Recommended (stops app, restores, restarts):**

```bash
cd /var/www/chatastay
npm run restore:db -- /var/www/chatastay/backups/sqlite/chatastay-YOUR-STAMP.db --pm2-offline-restore
```

**If you already stopped PM2 yourself:**

```bash
cd /var/www/chatastay
npm run restore:db -- ./backups/sqlite/chatastay-YOUR-STAMP.db
pm2 restart chatastay
```

**Optional:** append `--restart-pm2` to restart PM2 after restore (when you stopped the app manually first).

**Legacy:**

```bash
node scripts/restore-sqlite.cjs --from="/path/to/backup.db" --confirm-restore
```

The restore script validates the SQLite header and runs `PRAGMA quick_check`, takes an automatic **pre-restore** backup via `npm run backup:db`, then writes the live database.

## Cron: daily backup, 14-day retention, logs

1. Ensure the script is executable:

   ```bash
   chmod +x /var/www/chatastay/scripts/cron-daily-backup.sh
   ```

2. Use a **full PATH** for `npm` in cron if needed (`which npm`).

3. Crontab entry (example: **03:15** daily, UTC depends on server timezone):

   ```cron
   15 3 * * * CHATASTAY_ROOT=/var/www/chatastay /var/www/chatastay/scripts/cron-daily-backup.sh
   ```

4. Logs append to:

   ```text
   /var/www/chatastay/logs/backup.log
   ```

5. Retention: files matching `chatastay-*.db`, `chatastay-*.db-wal`, `chatastay-*.db-shm` under `backups/sqlite/` with **mtime older than 14 days** are deleted.

6. **Optional** same-day S3 upload after backup — set in the crontab line:

   ```cron
   15 3 * * * CHATASTAY_ROOT=/var/www/chatastay RUN_BACKUP_UPLOAD_S3=1 /var/www/chatastay/scripts/cron-daily-backup.sh
   ```

   If S3 env vars are missing, `backup:upload:s3` fails but the shell script logs a warning and does not remove the local backup.

## S3-compatible upload (`npm run backup:upload:s3`)

Uploads the **newest** `chatastay-*.db` in `backups/sqlite/`. It does **not** create a new local backup; run `npm run backup:db` first (cron does both in order).

### Required environment variables

| Variable | Description |
|----------|-------------|
| `S3_BUCKET` | Target bucket name |
| `S3_ACCESS_KEY_ID` | Access key |
| `S3_SECRET_ACCESS_KEY` | Secret key |

### Optional

| Variable | Description |
|----------|-------------|
| `S3_REGION` | AWS region (default `us-east-1`). Some providers accept `auto`. |
| `S3_ENDPOINT` | Custom endpoint URL (MinIO, Cloudflare R2, etc.) |
| `S3_PREFIX` | Key prefix/folder (default `chatastay-backups`, no leading slash) |
| `S3_FORCE_PATH_STYLE` | Set to `1` for many S3-compatible endpoints (path-style addressing) |

### Example: AWS S3

```bash
export S3_BUCKET=my-company-chatastay
export S3_REGION=eu-central-1
export S3_ACCESS_KEY_ID=AKIA...
export S3_SECRET_ACCESS_KEY=...
cd /var/www/chatastay
npm run backup:db
npm run backup:upload:s3
```

### Example: Cloudflare R2 (typical)

```bash
export S3_BUCKET=my-r2-bucket
export S3_REGION=auto
export S3_ENDPOINT=https://<ACCOUNT_ID>.r2.cloudflarestorage.com
export S3_ACCESS_KEY_ID=...
export S3_SECRET_ACCESS_KEY=...
export S3_PREFIX=chatastay/prod
export S3_FORCE_PATH_STYLE=1
cd /var/www/chatastay
npm run backup:db
npm run backup:upload:s3
```

Put exports in a root-only file such as `/var/www/chatastay/.env.s3` **not** committed to git, and `source` it from cron before upload if you use `RUN_BACKUP_UPLOAD_S3=1`.

## Deploy safety

Before risky operations (migrations, disk moves):

```bash
cd /var/www/chatastay
npm run backup:db
```

See also `npm run migrate:deploy` in your deploy checklist.

## Troubleshooting: admin pages empty but app runs

1. **Inspect DB (read-only)** — confirms which SQLite file is used, row counts, and whether `DEFAULT_HOTEL_SLUG` matches a `Hotel.slug`:

   ```bash
   cd /var/www/chatastay && npm run inspect:db
   ```

2. If the script warns that **no hotel matches `DEFAULT_HOTEL_SLUG`**, set in `.env`:

   ```env
   DEFAULT_HOTEL_SLUG=<exact-slug-from-Hotel-table>
   ```

   Then `pm2 restart chatastay --update-env`.

3. **Backups** only contain whatever is in the live DB today. If the DB was already empty when backups started, restore cannot recover old data; use an older backup file if you have one.

## NPM scripts reference

| Script | Purpose |
|--------|---------|
| `npm run backup:db` | Timestamped local backup |
| `npm run restore:db -- <path> [--pm2-offline-restore]` | Restore live DB from backup file (optional `--restart-pm2`) |
| `npm run backup:upload:s3` | Upload newest local backup to S3-compatible storage |
| `npm run backup:daily` | Run the same shell logic as cron (backup + retention + optional S3) |
| `npm run inspect:db` | Print resolved DB path, counts, hotel slugs vs `DEFAULT_HOTEL_SLUG` |
