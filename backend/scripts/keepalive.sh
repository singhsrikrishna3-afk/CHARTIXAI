#!/bin/bash
# Chartix keepalive watchdog.
# Keeps the backend (:8010) and a Cloudflare quick-tunnel alive, and whenever the
# tunnel URL changes it auto-updates the Vercel env var and redeploys — so the
# live site never silently points at a dead tunnel again.
#
# Run detached:  nohup bash scripts/keepalive.sh > logs/keepalive.log 2>&1 &

set -u
BACKEND_DIR="/Users/srikrishnasingh/AG1 BB/PEESTOCKS/backend"
FRONTEND_DIR="/Users/srikrishnasingh/AG1 BB/PEESTOCKS/frontend"
PORT=8010
TUNNEL_LOG="$BACKEND_DIR/logs/tunnel_keepalive.log"
URL_FILE="$BACKEND_DIR/logs/current_tunnel.txt"
VERCEL_SCOPE="singhsrikrishna3-5341s-projects"
VERCEL_TOKEN="$(cat ~/.vercel_token 2>/dev/null)"
CHECK_EVERY=30

log() { echo "$(date '+%F %T') $*"; }

start_backend() {
  log "starting backend on :$PORT"
  cd "$BACKEND_DIR" || exit 1
  nohup venv/bin/uvicorn app.main:app --host 0.0.0.0 --port "$PORT" > logs/backend8010.log 2>&1 &
  sleep 6
}

start_tunnel() {
  log "starting cloudflared tunnel"
  pkill -f "cloudflared tunnel" 2>/dev/null; sleep 2
  nohup cloudflared tunnel --protocol http2 --url "http://localhost:$PORT" > "$TUNNEL_LOG" 2>&1 &
  sleep 14
  local url
  # Exclude api.trycloudflare.com (cloudflared's control-plane host, which also
  # appears in the log) — we want the assigned quick-tunnel hostname only.
  url=$(grep -oE "https://[a-z0-9-]+\.trycloudflare\.com" "$TUNNEL_LOG" | grep -v '://api\.' | head -1)
  echo "$url" > "$URL_FILE"
  log "tunnel URL: $url"
  update_vercel "$url"
}

update_vercel() {
  local url="$1"
  [ -z "$url" ] && return
  [ -z "$VERCEL_TOKEN" ] && { log "no vercel token — skipping redeploy"; return; }
  log "pointing Vercel at $url and redeploying"
  cd "$FRONTEND_DIR" || return
  vercel env rm NEXT_PUBLIC_API_URL production --yes --scope "$VERCEL_SCOPE" --token "$VERCEL_TOKEN" >/dev/null 2>&1
  printf "%s/api" "$url" | vercel env add NEXT_PUBLIC_API_URL production --scope "$VERCEL_SCOPE" --token "$VERCEL_TOKEN" >/dev/null 2>&1
  vercel deploy --prod --force --scope "$VERCEL_SCOPE" --token "$VERCEL_TOKEN" >/dev/null 2>&1 &
  log "redeploy triggered"
}

# ── initial boot ──
curl -s -o /dev/null -w '' "http://localhost:$PORT/api/health" --max-time 5 || start_backend
# Reuse an already-healthy tunnel instead of rotating on every watchdog restart
# (each rotation forces a Vercel redeploy that briefly breaks the live site).
boot_url=$(cat "$URL_FILE" 2>/dev/null)
if [ -n "$boot_url" ] && pgrep -f "cloudflared tunnel" >/dev/null && \
   [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$boot_url/api/health" 2>/dev/null)" = "200" ]; then
  log "existing tunnel healthy — reusing $boot_url"
else
  start_tunnel
fi

# ── monitor loop ──
# Debounced: a single failed probe is usually a transient blip (a heavy scan
# briefly pegging the event loop, a momentary Cloudflare edge hiccup). Restarting
# on the first miss caused a rotate→Vercel-redeploy storm that left the live site
# pointed at a not-yet-deployed URL — which is what broke logins. So we require
# TWO consecutive failures before acting, and we skip the tunnel check on any
# cycle where we just restarted the backend (give it time to warm up).
backend_fails=0
tunnel_fails=0
while true; do
  sleep "$CHECK_EVERY"
  restarted_backend=0

  # backend health — 2 strikes, and probe twice before declaring it down
  if ! curl -s -o /dev/null --max-time 10 "http://localhost:$PORT/api/health"; then
    sleep 3
    if ! curl -s -o /dev/null --max-time 10 "http://localhost:$PORT/api/health"; then
      backend_fails=$((backend_fails + 1))
    else
      backend_fails=0
    fi
  else
    backend_fails=0
  fi
  if [ "$backend_fails" -ge 2 ]; then
    log "backend DOWN (${backend_fails}x) — restarting"
    start_backend
    backend_fails=0
    restarted_backend=1
  fi

  # tunnel health — skip right after a backend restart (it's still warming up)
  if [ "$restarted_backend" -eq 0 ]; then
    url=$(cat "$URL_FILE" 2>/dev/null)
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$url/api/health" 2>/dev/null)
    if [ "$code" != "200" ]; then
      tunnel_fails=$((tunnel_fails + 1))
    else
      tunnel_fails=0
    fi
    if [ "$tunnel_fails" -ge 2 ]; then
      log "tunnel unhealthy ($code, ${tunnel_fails}x) — restarting + rewiring Vercel"
      start_tunnel
      tunnel_fails=0
    fi
  fi
done
