"""Chartix alert engine — evaluate alerts, create notifications, deliver to Telegram.

Runs from cron every 10 minutes. Each run:
  1. Links pending Telegram accounts (matches `/start <code>` messages against
     user_prefs[telegram_link_code], saves chat id, confirms to the user).
  2. Evaluates alert rules (price / pattern) via the existing run_alert_check task.
  3. Evaluates SWING EVENTS on open paper trades against the latest EOD bar:
     stop hit · target-1 hit (book half!) · target-2 hit · results within 3 days.
     Deduped per trade+event via the pattern_type tag column.
  4. Delivers every notification created this run to the owner's Telegram
     (if linked). In-app bell shows them regardless.

Usage:  venv/bin/python scripts/check_alerts.py
"""
import json
import os
import sys
from datetime import date, datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sqlalchemy import create_engine, select, text
from sqlalchemy.orm import Session

from app.services import notifier

DB_URL = "sqlite:////Users/srikrishnasingh/AG1 BB/PEESTOCKS/peestock.db"
STATE_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                          "data", "telegram_offset.json")


# ── Telegram account linking ─────────────────────────────────

def link_telegram_accounts(session) -> int:
    """Match `/start <code>` bot messages to users holding that link code."""
    if not notifier.telegram_enabled():
        return 0
    # persist getUpdates offset so we never reprocess old messages
    offset = None
    try:
        with open(STATE_PATH) as fh:
            offset = json.load(fh).get("offset")
    except Exception:
        pass

    updates = notifier.get_updates(offset)
    if not updates:
        return 0
    linked = 0
    max_id = offset or 0
    for u in updates:
        max_id = max(max_id, u.get("update_id", 0) + 1)
        msg = u.get("message") or {}
        chat_id = (msg.get("chat") or {}).get("id")
        txt = (msg.get("text") or "").strip()
        if not chat_id or not txt.lower().startswith("/start"):
            continue
        parts = txt.split()
        code = parts[1].strip().upper() if len(parts) > 1 else ""
        if not code:
            notifier.send_telegram(chat_id, "👋 To link your Chartix account, open Chartix → Alerts → Link Telegram, then send me the code shown there as: /start CODE")
            continue
        row = session.execute(text(
            "SELECT user_id FROM user_prefs WHERE pref_key = 'telegram_link_code' "
            "AND UPPER(json_extract(value, '$.code')) = :code"
        ), {"code": code}).fetchone()
        if not row:
            notifier.send_telegram(chat_id, "❌ That code didn't match. Generate a fresh one on the Chartix Alerts page and try again.")
            continue
        uid = row[0]
        session.execute(text(
            "INSERT INTO user_prefs (user_id, pref_key, value, updated_at) "
            "VALUES (:uid, 'telegram_chat_id', :val, :now) "
            "ON CONFLICT(user_id, pref_key) DO UPDATE SET value = :val, updated_at = :now"
        ), {"uid": uid, "val": json.dumps({"chat_id": chat_id}), "now": datetime.utcnow().isoformat()})
        session.execute(text(
            "DELETE FROM user_prefs WHERE user_id = :uid AND pref_key = 'telegram_link_code'"
        ), {"uid": uid})
        notifier.send_telegram(chat_id, "✅ <b>Chartix linked!</b> You'll get alerts here: price triggers, pattern hits, and swing events on your paper trades (stop / target / earnings).")
        linked += 1
    session.commit()
    os.makedirs(os.path.dirname(STATE_PATH), exist_ok=True)
    with open(STATE_PATH, "w") as fh:
        json.dump({"offset": max_id}, fh)
    return linked


# ── Swing events on open paper trades ────────────────────────

def _get_or_create_swing_rule(session, user_id, instrument_id):
    """TriggeredAlert requires an alert_rule_id; system swing events hang off a
    per-user synthetic rule (alert_type='swing_events', kept inactive so the
    price/pattern evaluators ignore it)."""
    row = session.execute(text(
        "SELECT id FROM alert_rules WHERE user_id = :uid AND alert_type = 'swing_events' LIMIT 1"
    ), {"uid": user_id}).fetchone()
    if row:
        return row[0]
    session.execute(text(
        "INSERT INTO alert_rules (user_id, instrument_id, alert_type, is_active, created_at) "
        "VALUES (:uid, :iid, 'swing_events', 0, :now)"
    ), {"uid": user_id, "iid": instrument_id, "now": datetime.utcnow().isoformat()})
    return session.execute(text(
        "SELECT id FROM alert_rules WHERE user_id = :uid AND alert_type = 'swing_events' LIMIT 1"
    ), {"uid": user_id}).fetchone()[0]


def check_swing_events(session) -> int:
    """Notify stop/T1/T2 touches on the latest bar + upcoming earnings, once per
    trade+event (deduped through the pattern_type tag)."""
    trades = session.execute(text(
        "SELECT pt.id, pt.user_id, pt.symbol, pt.direction, pt.entry_price, pt.stop, "
        "       pt.target1, pt.target2, i.id AS iid "
        "FROM paper_trades pt JOIN instruments i ON i.symbol = pt.symbol "
        "WHERE pt.status = 'open'"
    )).fetchall()
    created = 0
    today = date.today()
    for t in trades:
        tid, uid, sym, direction, entry, stop, t1, t2, iid = t
        long = (direction or "long") == "long"
        bar = session.execute(text(
            "SELECT time, high, low, close FROM ohlcv_eod WHERE instrument_id = :iid "
            "AND close IS NOT NULL ORDER BY time DESC LIMIT 1"
        ), {"iid": iid}).fetchone()
        if not bar:
            continue
        btime, hi, lo, close = str(bar[0])[:10], float(bar[1]), float(bar[2]), float(bar[3])

        events = []  # (tag, message)
        # Closing-basis stop: fires only when the day CLOSES beyond the stop.
        if stop is not None and ((close <= float(stop)) if long else (close >= float(stop))):
            events.append((f"pt_stop_{tid}", f"🛑 {sym}: closed at ₹{close:.2f}, beyond your stop ₹{float(stop):.2f} on {btime} — closing-basis stop hit."))
        else:
            if t1 is not None and ((hi >= float(t1)) if long else (lo <= float(t1))):
                events.append((f"pt_t1_{tid}", f"🎯 {sym}: Target 1 ₹{float(t1):.2f} hit on {btime} — book half, stop to breakeven, run the rest."))
            if t2 is not None and ((hi >= float(t2)) if long else (lo <= float(t2))):
                events.append((f"pt_t2_{tid}", f"🏆 {sym}: Target 2 ₹{float(t2):.2f} hit on {btime} — runner done. Well traded."))

        erow = session.execute(text(
            "SELECT next_earnings FROM earnings_calendar WHERE symbol = :s"
        ), {"s": sym}).fetchone()
        if erow and erow[0]:
            try:
                ed = datetime.strptime(str(erow[0])[:10], "%Y-%m-%d").date()
                days = (ed - today).days
                if 0 <= days <= 3:
                    events.append((f"pt_earn_{tid}_{ed.isoformat()}",
                                   f"📊 {sym}: results on {ed.isoformat()} ({days}d away) and your paper trade is open — exit or consciously hold through?"))
            except Exception:
                pass

        if not events:
            continue
        rule_id = _get_or_create_swing_rule(session, uid, iid)
        for tag, message in events:
            dup = session.execute(text(
                "SELECT 1 FROM triggered_alerts WHERE alert_rule_id = :rid AND pattern_type = :tag LIMIT 1"
            ), {"rid": rule_id, "tag": tag[:50]}).fetchone()
            if dup:
                continue
            session.execute(text(
                "INSERT INTO triggered_alerts (alert_rule_id, user_id, instrument_id, pattern_type, message, triggered_at, is_read) "
                "VALUES (:rid, :uid, :iid, :tag, :msg, :now, 0)"
            ), {"rid": rule_id, "uid": uid, "iid": iid, "tag": tag[:50], "msg": message,
                "now": datetime.utcnow().isoformat()})
            created += 1
    session.commit()
    return created


# ── Delivery ─────────────────────────────────────────────────

def deliver_new(session, since_id: int) -> int:
    """Push every notification created after since_id to its owner's Telegram."""
    if not notifier.telegram_enabled():
        return 0
    rows = session.execute(text(
        "SELECT ta.id, ta.user_id, ta.message FROM triggered_alerts ta "
        "WHERE ta.id > :sid ORDER BY ta.user_id, ta.id"
    ), {"sid": since_id}).fetchall()
    if not rows:
        return 0
    chat_ids = {}
    for r in session.execute(text(
        "SELECT user_id, json_extract(value, '$.chat_id') FROM user_prefs WHERE pref_key = 'telegram_chat_id'"
    )).fetchall():
        chat_ids[r[0]] = r[1]
    sent = 0
    by_user = {}
    for _id, uid, msg in rows:
        by_user.setdefault(uid, []).append(msg)
    for uid, msgs in by_user.items():
        chat = chat_ids.get(uid)
        if not chat:
            continue
        body = "🔔 <b>Chartix alerts</b>\n\n" + "\n\n".join(msgs[:10])
        if notifier.send_telegram(chat, body):
            sent += len(msgs)
    return sent


def main():
    engine = create_engine(DB_URL, connect_args={"timeout": 30})
    with Session(engine) as session:
        max_id = session.execute(text("SELECT COALESCE(MAX(id), 0) FROM triggered_alerts")).scalar()

        linked = link_telegram_accounts(session)

        # price/pattern rules — reuse the existing celery task body directly
        from app.workers.tasks_eod import run_alert_check
        rule_result = run_alert_check()

        swing = check_swing_events(session)
        sent = deliver_new(session, max_id)

    print(f"{datetime.now():%F %T} linked={linked} rules_triggered={rule_result.get('triggered')} "
          f"swing_events={swing} telegram_sent={sent} "
          f"(telegram {'ON' if notifier.telegram_enabled() else 'off — set TELEGRAM_BOT_TOKEN'})")


if __name__ == "__main__":
    main()
