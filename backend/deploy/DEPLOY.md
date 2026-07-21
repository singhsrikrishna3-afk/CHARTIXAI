# Chartix — VPS Migration Runbook

Moves the backend off your Mac + cloudflared tunnel onto a real server with a
**stable HTTPS URL that never changes**, auto-restart on crash/reboot, and nightly
backups. This deletes the tunnel, `keepalive.sh`, and the Vercel redeploy churn.

The frontend **stays on Vercel** — you only repoint it once, at the end.

**Layout on the server** (matches how the app resolves paths today):
```
/opt/chartix/                 ← repo root (config BASE_DIR)
├── peestock.db               ← the 2.4 GB SQLite DB (BASE_DIR/peestock.db)
└── backend/
    ├── venv/
    ├── .env                  ← secrets (copied from your Mac)
    ├── app/  scripts/  deploy/  logs/
```

---

## 0. Before you start
- A VPS: **DigitalOcean Bangalore (BLR1), 8 GB / 4 vCPU** (best for Indian users), or
  Hetzner CPX31 (8 GB, cheaper, EU). Ubuntu 24.04.
- A domain you control (e.g. `chartix.in`). In DNS, add an **A record**:
  `api.chartix.in → <droplet public IP>`. Wait for it to resolve (`dig api.chartix.in`).

---

## 1. Create the service user + firewall
SSH in as root, then:
```bash
adduser --system --group --home /opt/chartix chartix
mkdir -p /opt/chartix/backend/logs /opt/chartix/backups
apt update && apt -y upgrade

# firewall: only SSH + HTTP/HTTPS open. The API port 8010 stays private.
ufw allow OpenSSH
ufw allow 80,443/tcp
ufw --force enable
```

## 2. System dependencies
```bash
apt -y install python3.11 python3.11-venv python3.11-dev build-essential \
               sqlite3 redis-server git curl
systemctl enable --now redis-server
timedatectl set-timezone Asia/Kolkata      # so the 18:30 cron = IST
```
Install **Caddy** (auto-HTTPS):
```bash
apt -y install debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
apt update && apt -y install caddy
```

## 3. Get the code + build the venv
Copy the repo up from your Mac (run this **on the Mac**):
```bash
# from /Users/srikrishnasingh/AG1 BB/PEESTOCKS
rsync -av --exclude 'backend/venv' --exclude 'peestock.db' --exclude '__pycache__' \
      --exclude 'node_modules' --exclude 'frontend' \
      ./ root@<IP>:/opt/chartix/
```
Back **on the server**, build the environment:
```bash
cd /opt/chartix/backend
python3.11 -m venv venv
venv/bin/pip install --upgrade pip
venv/bin/pip install -r requirements.txt
```

## 4. Copy the database over
Run **on the Mac** (stop writes first for a clean copy, or just use the latest backup):
```bash
# make a consistent snapshot, then ship it
sqlite3 "/Users/srikrishnasingh/AG1 BB/PEESTOCKS/peestock.db" ".backup '/tmp/peestock.db'"
rsync -av --progress /tmp/peestock.db root@<IP>:/opt/chartix/peestock.db
```

## 5. Secrets (.env)
Copy your **existing** `.env` up so the JWT secret is identical (keeps everyone
logged in). Run **on the Mac**:
```bash
rsync -av "/Users/srikrishnasingh/AG1 BB/PEESTOCKS/backend/.env" root@<IP>:/opt/chartix/backend/.env
```
On the server, add the production frontend origin if you later use a custom domain
(the Vercel origin is already allowed by default). Then lock ownership:
```bash
chown -R chartix:chartix /opt/chartix
chmod 600 /opt/chartix/backend/.env
```

## 6. Backend as a systemd service (replaces nohup + keepalive.sh)
```bash
cp /opt/chartix/backend/deploy/chartix-api.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now chartix-api
systemctl status chartix-api --no-pager      # should be active (running)
curl -s http://127.0.0.1:8010/api/health     # {"status":"ok",...}
```
(Optional Celery worker — only if you add async forecast precompute:)
```bash
cp /opt/chartix/backend/deploy/chartix-worker.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now chartix-worker
```

## 7. HTTPS with Caddy
```bash
mkdir -p /var/log/caddy && chown caddy:caddy /var/log/caddy
cp /opt/chartix/backend/deploy/Caddyfile /etc/caddy/Caddyfile
# edit the domain inside it to your real subdomain:
sed -i 's/api\.chartix\.in/api.YOURDOMAIN/' /etc/caddy/Caddyfile
systemctl reload caddy
# from your laptop, this should now return the health JSON over real HTTPS:
curl -s https://api.YOURDOMAIN/api/health
```

## 8. Cron (daily sync + nightly backup)
```bash
chmod +x /opt/chartix/backend/deploy/backup_db.sh
sudo -u chartix crontab /opt/chartix/backend/deploy/crontab.txt
sudo -u chartix crontab -l                   # verify
/opt/chartix/backend/deploy/backup_db.sh      # test a backup now
```

## 9. Point Vercel at the stable URL — once, forever
On your Mac (or the Vercel dashboard):
```bash
cd "/Users/srikrishnasingh/AG1 BB/PEESTOCKS/frontend"
TOKEN=$(cat ~/.vercel_token); SCOPE="singhsrikrishna3-5341s-projects"
vercel env rm NEXT_PUBLIC_API_URL production --yes --scope "$SCOPE" --token "$TOKEN"
printf "https://api.YOURDOMAIN/api" | vercel env add NEXT_PUBLIC_API_URL production --scope "$SCOPE" --token "$TOKEN"
vercel deploy --prod --force --scope "$SCOPE" --token "$TOKEN"
```
This URL never changes again — no more rotation, no more "Load failed".

## 10. Verify end-to-end
- `https://api.YOURDOMAIN/api/health` → 200
- Log in on `chartix-pi.vercel.app` → works
- Recommendations / charts load

## 11. Retire the Mac plumbing
Once traffic flows through the VPS:
```bash
pkill -f keepalive.sh
pkill -f "cloudflared tunnel"
# remove the daily_sync cron on the Mac (it now runs on the server):
crontab -l | grep -v 'AG1 BB/PEESTOCKS/backend/scripts/daily_sync.py' | crontab -
```
Your laptop is a laptop again.

---

## Everyday operations
```bash
systemctl restart chartix-api          # restart backend
journalctl -u chartix-api -f           # live logs  (or tail logs/api.log)
systemctl status chartix-api           # health
```
**Deploy a code update** (from the Mac):
```bash
rsync -av --exclude venv --exclude peestock.db --exclude __pycache__ \
      backend/ root@<IP>:/opt/chartix/backend/
ssh root@<IP> 'systemctl restart chartix-api'
```
**Restore from backup:**
```bash
systemctl stop chartix-api
gunzip -c /opt/chartix/backups/peestock_<STAMP>.db.gz > /opt/chartix/peestock.db
chown chartix:chartix /opt/chartix/peestock.db
systemctl start chartix-api
```

## What this fixes (vs. today)
| Problem today | After migration |
|---|---|
| Tunnel URL rotates / dies | Fixed HTTPS domain, never changes |
| Mac sleeps / OOM kills backend | Always-on server + systemd memory guards + auto-restart |
| keepalive.sh flapping → redeploy storms | Gone — systemd handles restarts locally |
| DB only on the Mac | Nightly backups (+ optional offsite) |
| Python 3.9 quirks | Python 3.11 |
