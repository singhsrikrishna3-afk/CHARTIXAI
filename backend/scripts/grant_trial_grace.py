"""Grant a grace-period free subscription to pre-existing accounts.

The 7-day free trial counts from signup, so accounts created before the trial
shipped would lose access the moment it went live — they signed up under a
"free forever" promise. This gives them a fresh free window to land softly.

Skips admins, anyone already holding a live paid plan, and EXCLUDE_EMAILS.

Idempotent: it rewrites the account's existing free sub in place rather than
inserting another row (piled-up rows are what made tier resolution ambiguous in
the first place), and skips anyone whose free access already reaches the grace
date. Meant to be run once at migration; re-running the same day is a no-op.

    python scripts/grant_trial_grace.py            # dry run, prints the plan
    python scripts/grant_trial_grace.py --apply    # actually write
    python scripts/grant_trial_grace.py --apply --days 21
"""
import argparse
import sqlite3
import sys
import uuid
from datetime import datetime, timedelta
from pathlib import Path

DB = Path(__file__).resolve().parents[2] / "peestock.db"

# Accounts that must never be touched by this script.
EXCLUDE_EMAILS = {"singhsrikrishna3@gmail.com"}

PAID_TIERS = {"eod_basic", "eod_pro", "ai_eod_pro", "intraday", "intraday_pro",
              "eod_basic_weekly", "eod_pro_weekly", "ai_eod_pro_weekly"}


def _naive(v):
    """subscriptions.expires_at is stored as a string; tolerate both formats."""
    if not v:
        return None
    try:
        return datetime.strptime(str(v).split(".")[0], "%Y-%m-%d %H:%M:%S")
    except ValueError:
        try:
            return datetime.fromisoformat(str(v))
        except ValueError:
            return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="write changes (default: dry run)")
    ap.add_argument("--days", type=int, default=14, help="grace window length")
    args = ap.parse_args()

    now = datetime.utcnow()
    until = now + timedelta(days=args.days)
    conn = sqlite3.connect(DB, timeout=30)
    conn.row_factory = sqlite3.Row

    planned, skipped = [], []
    for u in conn.execute("SELECT id, email, is_admin, created_at FROM users").fetchall():
        if u["email"] in EXCLUDE_EMAILS:
            skipped.append((u["email"], "excluded by name"))
            continue
        if u["is_admin"]:
            skipped.append((u["email"], "admin — bypasses gates anyway"))
            continue

        subs = conn.execute(
            "SELECT tier, status, expires_at FROM subscriptions "
            "WHERE user_id = ? AND status IN ('active','trial')", (u["id"],)
        ).fetchall()
        live = [s for s in subs
                if _naive(s["expires_at"]) is None or _naive(s["expires_at"]) >= now]

        if any(s["tier"] in PAID_TIERS for s in live):
            skipped.append((u["email"], "already on a live paid plan"))
            continue
        # Already reaches the grace date (minus a day of slack, so re-running the
        # same day doesn't churn)? Leave it.
        if any(_naive(s["expires_at"]) and _naive(s["expires_at"]) >= until - timedelta(days=1)
               for s in live):
            skipped.append((u["email"], "free access already runs past the grace date"))
            continue

        created = _naive(u["created_at"])
        age = (now - created).days if created else None
        planned.append((u["id"], u["email"], age))

    print(f"DB: {DB}")
    print(f"Grace: free tier through {until:%Y-%m-%d %H:%M} ({args.days} days)\n")
    print(f"WILL GRANT ({len(planned)}):")
    for _, email, age in planned:
        print(f"   {email:36} signed up {age}d ago")
    print(f"\nSKIPPED ({len(skipped)}):")
    for email, why in skipped:
        print(f"   {email:36} {why}")

    if not args.apply:
        print("\nDry run — nothing written. Re-run with --apply to commit.")
        return

    until_s = until.strftime("%Y-%m-%d %H:%M:%S")
    now_s = now.strftime("%Y-%m-%d %H:%M:%S")
    for uid, email, _ in planned:
        # Extend an existing free trial row in place if one exists; only insert
        # when the account has no free row at all. Avoids piling up rows, which
        # is what made "which subscription is authoritative?" ambiguous.
        existing = conn.execute(
            "SELECT id FROM subscriptions WHERE user_id = ? AND tier = 'free' "
            "ORDER BY created_at DESC LIMIT 1", (uid,)
        ).fetchone()
        if existing:
            conn.execute(
                "UPDATE subscriptions SET status='trial', expires_at=? WHERE id=?",
                (until_s, existing["id"]),
            )
        else:
            conn.execute(
                "INSERT INTO subscriptions (id, user_id, tier, status, starts_at, expires_at, created_at) "
                "VALUES (?, ?, 'free', 'trial', ?, ?, ?)",
                (uuid.uuid4().hex, uid, now_s, until_s, now_s),
            )
    conn.commit()
    print(f"\nGranted grace to {len(planned)} account(s).")


if __name__ == "__main__":
    sys.exit(main())
