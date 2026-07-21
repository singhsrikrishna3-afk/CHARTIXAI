# Chartix — Going Live (Vercel + VPS)

Chartix is two deployables:

| Piece | Where it runs | Why |
|---|---|---|
| `frontend/` (Next.js) | **Vercel** | Perfect fit — static + SSR pages, free tier is enough |
| `backend/` (FastAPI + SQLite/PostgreSQL + torch + Celery) | **A VPS or PaaS** (Hetzner / DigitalOcean / Railway / Render) | Needs persistent disk (2.4 GB DB), long-running Python, heavy deps. Vercel cannot host this |

---

## 1. Backend first (the API must exist before the frontend points at it)

### Recommended: a small VPS (Hetzner CX22 / DO basic droplet, ~$5–8/mo, 4 GB RAM)

```bash
# on the server (Ubuntu 24.04)
sudo apt update && sudo apt install -y python3.12-venv nginx
git clone <your-repo> chartix && cd chartix/backend
python3 -m venv venv && venv/bin/pip install -r requirements.txt

# copy the database up (from your machine)
rsync -avP peestock.db user@server:~/chartix/

# configure
cp .env.example .env   # then edit:
#   JWT_SECRET      → long random string:  openssl rand -hex 48
#   CORS_ORIGINS    → https://<your-app>.vercel.app (+ custom domain later)
#   DATABASE_URL    → sqlite:////home/user/chartix/peestock.db?timeout=30
#                     (SQLite is fine to start; PostgreSQL migration script is
#                      ready in scripts/migrate_sqlite_to_postgres.py for later)

# run under systemd (survives reboots)
sudo tee /etc/systemd/system/chartix.service <<'EOF'
[Unit]
Description=Chartix API
After=network.target
[Service]
WorkingDirectory=/home/user/chartix/backend
ExecStart=/home/user/chartix/backend/venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000 --workers 2
Restart=always
[Install]
WantedBy=multi-user.target
EOF
sudo systemctl enable --now chartix

# nginx reverse proxy + TLS
# proxy api.yourdomain.com → 127.0.0.1:8000, then:
sudo snap install certbot --classic && sudo certbot --nginx -d api.yourdomain.com
```

Daily data sync: add a cron entry that calls the EOD sync after market close, e.g.
`30 18 * * 1-5  curl -s -X POST http://127.0.0.1:8000/api/instruments/sync -H "Authorization: Bearer <admin token>"`.

### Alternative: Railway/Render
Works with a Dockerfile; attach a persistent volume for the DB. Higher cost at
this DB size than a plain VPS, but zero server admin.

---

## 2. Frontend on Vercel

```bash
cd frontend
vercel login          # one-time, opens browser
vercel link           # create/link the project (root dir = frontend/)
vercel env add NEXT_PUBLIC_API_URL production
#   value: https://api.yourdomain.com/api   ← your backend URL + /api
vercel --prod
```

Or via the Vercel dashboard: **New Project → import repo → Root Directory =
`frontend` → add env var `NEXT_PUBLIC_API_URL` → Deploy**.

After the first deploy, copy the Vercel domain into the backend's
`CORS_ORIGINS` and restart the API service.

---

## 3. Pre-launch checklist

- [ ] `JWT_SECRET` set to a real random value (the app logs a security warning until it is)
- [ ] `CORS_ORIGINS` includes the exact Vercel/custom domain (https, no trailing slash)
- [ ] `NEXT_PUBLIC_API_URL` points at the backend **with** the `/api` suffix
- [ ] `DEBUG=false`
- [ ] Admin account has `is_admin=1` in the DB (payments approval panel)
- [ ] UPI: `UPI_ID`/`UPI_NAME` match the real payee account name
- [ ] Daily EOD sync cron in place
- [ ] Test: register → free trial works → run a scan → open a chart → UPI flow reaches the pending-approval state

## Notes
- **Celery/Redis are optional at launch** — LSTM forecasts can be refreshed via
  the training script on a cron instead of a live worker.
- **PostgreSQL** becomes worthwhile past a few hundred daily users; the code
  and migration script already support it (see `backend/scripts/`).
