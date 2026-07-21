"""Chartix — outbound notification transport (Telegram).

Telegram is the delivery channel: free, instant, and where Indian trading
crowds already live. Requires two env vars in backend/.env:

    TELEGRAM_BOT_TOKEN=123456:ABC...   (from @BotFather → /newbot)
    TELEGRAM_BOT_USERNAME=ChartixAlertsBot

Until they're set every send is a graceful no-op, so the alert engine can run
(and fill the in-app bell) without Telegram configured.

Linking flow: the user clicks "Link Telegram" in the app → we mint a short code
stored in user_prefs[telegram_link_code] → they send `/start <code>` to the bot
→ the cron poller (scripts/check_alerts.py) matches it via getUpdates and saves
their chat id in user_prefs[telegram_chat_id].
"""
import logging
import os

import requests

logger = logging.getLogger(__name__)

API = "https://api.telegram.org/bot{token}/{method}"


def bot_token() -> str:
    # settings first (pydantic loads .env itself; it does NOT export to os.environ)
    try:
        from app.config import get_settings
        tok = (get_settings().TELEGRAM_BOT_TOKEN or "").strip()
        if tok:
            return tok
    except Exception:
        pass
    return os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()


def bot_username() -> str:
    try:
        from app.config import get_settings
        u = (get_settings().TELEGRAM_BOT_USERNAME or "").strip().lstrip("@")
        if u:
            return u
    except Exception:
        pass
    return os.environ.get("TELEGRAM_BOT_USERNAME", "").strip().lstrip("@")


def telegram_enabled() -> bool:
    return bool(bot_token())


def send_telegram(chat_id, text: str) -> bool:
    """Send a message; returns True on success. No-op (False) when unconfigured."""
    token = bot_token()
    if not token or not chat_id:
        return False
    try:
        r = requests.post(
            API.format(token=token, method="sendMessage"),
            json={"chat_id": chat_id, "text": text, "parse_mode": "HTML",
                  "disable_web_page_preview": True},
            timeout=15,
        )
        ok = r.status_code == 200 and r.json().get("ok")
        if not ok:
            logger.warning("telegram send failed: %s %s", r.status_code, r.text[:200])
        return bool(ok)
    except Exception as e:
        logger.warning("telegram send error: %s", e)
        return False


def get_updates(offset: int = None) -> list:
    """Poll pending bot updates (used by the cron linker). [] when unconfigured."""
    token = bot_token()
    if not token:
        return []
    try:
        params = {"timeout": 0, "allowed_updates": '["message"]'}
        if offset is not None:
            params["offset"] = offset
        r = requests.get(API.format(token=token, method="getUpdates"),
                         params=params, timeout=20)
        if r.status_code == 200 and r.json().get("ok"):
            return r.json().get("result", [])
    except Exception as e:
        logger.warning("telegram getUpdates error: %s", e)
    return []
