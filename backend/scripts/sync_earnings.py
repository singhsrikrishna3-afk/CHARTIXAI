"""Earnings Shield — sync upcoming earnings dates from Yahoo Finance.

Fetches each active EQ stock's next earnings date (Ticker.calendar) and stores it
in the earnings_calendar table. The trade-plan API joins against this to warn on
(or exclude) setups that would enter right before results, and to flag open paper
trades holding into earnings.

Usage:
  venv/bin/python scripts/sync_earnings.py                 # full universe (~30-45 min)
  venv/bin/python scripts/sync_earnings.py --symbols A,B   # just these symbols
  venv/bin/python scripts/sync_earnings.py --priority      # reco cache + paper trades + watchlists only (fast)

Cron (weekly refresh — dates don't move often):
  0 7 * * 0 cd <backend> && venv/bin/python scripts/sync_earnings.py >> logs/earnings.log 2>&1
"""
import argparse
import json
import os
import sqlite3
import sys
import time
from datetime import date, datetime

import yfinance as yf

DB = "/Users/srikrishnasingh/AG1 BB/PEESTOCKS/peestock.db"

# BSE-only listings (same map as daily_sync)
BSE_ONLY = {"ANDHRAPET": "ANDHRAPET.BO"}


def ensure_table(con):
    con.execute(
        "CREATE TABLE IF NOT EXISTS earnings_calendar ("
        " symbol TEXT PRIMARY KEY,"
        " next_earnings DATE,"
        " fetched_at TEXT)"
    )
    con.commit()


def yf_ticker(symbol):
    return BSE_ONLY.get(symbol, f"{symbol}.NS")


def fetch_one(symbol):
    """Return the next earnings date (date) or None. Tries Ticker.calendar first,
    falls back to get_earnings_dates (needs lxml) which covers many smaller NSE
    names the calendar endpoint misses."""
    today = date.today()
    t = yf.Ticker(yf_ticker(symbol))
    try:
        cal = t.calendar or {}
        dates = [d for d in (cal.get("Earnings Date") or []) if isinstance(d, date)]
    except Exception:
        dates = []
    if not dates:
        try:
            ed = t.get_earnings_dates(limit=8)
            if ed is not None and len(ed):
                dates = [ts.date() for ts in ed.index]
        except Exception:
            pass
    if not dates:
        return None
    future = sorted(d for d in dates if d >= today)
    if future:
        return future[0]
    # only past dates known (recently reported = safe window for a while)
    return max(dates)


def priority_symbols(con):
    """Symbols that matter most right now: cached recommendations, open paper
    trades, and watchlist entries."""
    syms = set()
    try:
        for (s,) in con.execute("SELECT DISTINCT symbol FROM paper_trades WHERE status='open'"):
            syms.add(s)
    except sqlite3.OperationalError:
        pass
    try:
        for (s,) in con.execute("SELECT DISTINCT symbol FROM watchlist_items"):
            syms.add(s)
    except sqlite3.OperationalError:
        pass
    # symbols in the current reco cache file, if the API has written one recently
    return syms


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--symbols", help="comma-separated symbols")
    ap.add_argument("--priority", action="store_true", help="open trades + watchlists only")
    ap.add_argument("--missing-only", action="store_true",
                    help="only symbols with no stored date yet")
    ap.add_argument("--delay", type=float, default=1.2,
                    help="seconds between requests — Yahoo rate-limits fast bulk runs "
                         "(a 0.4s/req blitz silently returned no data for most symbols)")
    args = ap.parse_args()

    con = sqlite3.connect(DB)
    ensure_table(con)

    if args.symbols:
        symbols = [s.strip().upper() for s in args.symbols.split(",") if s.strip()]
    elif args.priority:
        symbols = sorted(priority_symbols(con))
    else:
        symbols = [r[0] for r in con.execute(
            "SELECT symbol FROM instruments WHERE is_active=1 AND segment='EQ' ORDER BY symbol"
        ).fetchall()]

    if args.missing_only:
        have = {r[0] for r in con.execute("SELECT symbol FROM earnings_calendar").fetchall()}
        symbols = [s for s in symbols if s not in have]

    print(f"{datetime.now():%F %T} syncing earnings for {len(symbols)} symbols "
          f"(delay {args.delay}s)", flush=True)
    ok = miss = 0
    t0 = time.time()
    for i, sym in enumerate(symbols, 1):
        time.sleep(args.delay)
        d = fetch_one(sym)
        if d is not None:
            con.execute(
                "INSERT INTO earnings_calendar(symbol, next_earnings, fetched_at) VALUES(?,?,?) "
                "ON CONFLICT(symbol) DO UPDATE SET next_earnings=excluded.next_earnings, fetched_at=excluded.fetched_at",
                (sym, d.isoformat(), datetime.utcnow().isoformat()),
            )
            ok += 1
        else:
            miss += 1
        if i % 25 == 0:
            con.commit()
            print(f"  [{i}/{len(symbols)}] ok={ok} miss={miss} elapsed={time.time()-t0:.0f}s", flush=True)
    con.commit()
    print(f"{datetime.now():%F %T} done: {ok} dates stored, {miss} without data ({time.time()-t0:.0f}s)", flush=True)


if __name__ == "__main__":
    main()
