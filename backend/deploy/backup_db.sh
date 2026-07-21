#!/usr/bin/env bash
# Chartix nightly database backup.
# Uses SQLite's online .backup (safe on a live DB — no downtime, no corruption),
# compresses it, and keeps the last 7 days. Optionally pushes offsite (see bottom).
#
# Install: copy to /opt/chartix/backend/deploy/, chmod +x, add the cron line from
# deploy/crontab.txt. Restore = gunzip a snapshot and put it at /opt/chartix/peestock.db.
set -euo pipefail

DB="/opt/chartix/peestock.db"
DEST="/opt/chartix/backups"
KEEP=7
STAMP="$(date +%F_%H%M)"

mkdir -p "$DEST"
# Consistent hot backup (do NOT just cp a live SQLite file).
sqlite3 "$DB" ".backup '$DEST/peestock_${STAMP}.db'"
gzip -f "$DEST/peestock_${STAMP}.db"

# Rotate: keep only the newest $KEEP snapshots.
ls -1t "$DEST"/peestock_*.db.gz 2>/dev/null | tail -n +"$((KEEP + 1))" | xargs -r rm -f

echo "$(date '+%F %T') backup ok -> peestock_${STAMP}.db.gz ($(du -h "$DEST/peestock_${STAMP}.db.gz" | cut -f1))"

# ── OPTIONAL offsite copy (uncomment after installing rclone + configuring a
# remote such as Backblaze B2 or S3). This is your insurance against the whole
# droplet dying. ~₹0–20/month for this much data.
# rclone copy "$DEST/peestock_${STAMP}.db.gz" b2:chartix-backups/ --quiet
