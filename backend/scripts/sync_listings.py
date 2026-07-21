"""Chartix — NSE mainboard listing sync (find & add stocks we don't have yet).

New NSE listings don't appear in `instruments` on their own, so freshly-IPO'd
stocks silently stay invisible to every scanner. This diffs NSE's official
mainboard master against the DB, inserts what's missing and backfills history.

Source of truth is NSE's own equity master, NOT the bhavcopy:

    https://archives.nseindia.com/content/equities/EQUITY_L.csv

It carries company name, ISIN, lot size and series for every mainboard
listing, including ones that didn't trade today (the bhavcopy only has the
day's actual trades, so a suspended or illiquid name looks "missing" there).

Scope — mainboard only (matches the existing instrument universe):
  EQ / BE / BZ …  in this file
  SME (Emerge, series SM/ST) is a DIFFERENT universe — thin liquidity and
  lot-size-only trading — and is deliberately NOT covered here. ~23 backend
  queries select the scan universe with `segment='EQ' AND is_active=1`, so
  anything inserted as EQ lands in every scanner immediately.

BZ is the exchange's suspended/insolvent bucket (HDIL, IL&FS, Sanwaria…).
Skipped by default — those names error on every sync and only add noise.
Pass --include-bz to insert them anyway (as is_active=0).

Brand-new listings often have no Yahoo ticker for a day or two. They're still
inserted (so daily_sync picks them up automatically once the feed appears) and
reported at the end rather than treated as failures.

Usage:
    venv/bin/python scripts/sync_listings.py --dry-run    # report only
    venv/bin/python scripts/sync_listings.py              # add + backfill max
"""

import argparse
import csv
import io
import logging
import os
import sys
from datetime import datetime, time as _time, timedelta, timezone

import requests
import yfinance as yf
from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session

sys.path.insert(0, os.path.abspath(os.path.dirname(__file__)))
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
import nse_bhav  # noqa: E402
from app.config import get_settings  # noqa: E402

log = logging.getLogger(__name__)

# Same rule as daily_sync: mid-session Yahoo hands back a PARTIAL bar for the
# current day, and writing it corrupts the EOD table every scanner reads from.
# Today's bar only counts once the session has actually finished.
IST = timezone(timedelta(hours=5, minutes=30))
_MARKET_CLOSE = _time(15, 45)   # 15:30 close + settle buffer


def _cutoff_date():
    now = datetime.now(IST)
    return now.date() if now.time() >= _MARKET_CLOSE else (now.date() - timedelta(days=1))

MASTER_URL = "https://archives.nseindia.com/content/equities/EQUITY_L.csv"
HEADERS = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"}

# Suspended / insolvent bucket — no live feed, excluded unless asked for.
SUSPENDED_SERIES = {"BZ"}

# REITs / InvITs. Not in the equity master, so discovered from the bhavcopy.
TRUST_SERIES = {"RR", "IV"}


def _db_url():
    return get_settings().DATABASE_URL.replace("+aiosqlite", "").replace("+asyncpg", "")


def _fetch_master():
    r = requests.get(MASTER_URL, headers=HEADERS, timeout=30)
    r.raise_for_status()
    if "SYMBOL" not in r.text[:200]:
        raise RuntimeError("EQUITY_L.csv did not look like the NSE master")
    return [{(k or "").strip(): (v or "").strip() for k, v in row.items()}
            for row in csv.DictReader(io.StringIO(r.text))]


def _fetch_trusts(cutoff, lookback=7):
    """REIT / InvIT symbols currently trading (bhavcopy series RR / IV).

    EQUITY_L.csv is the *equity* master — it lists no REITs or InvITs at all,
    so they can never surface from a master diff. That blind spot is why 13
    actively-traded trusts sat missing. They exist only in the bhavcopy.

    Walks back several sessions on purpose: these are illiquid and several
    don't trade every day, so any single day's file undercounts them.
    """
    trusts = set()
    for back in range(lookback):
        d = cutoff - timedelta(days=back)
        if d.weekday() >= 5:
            continue
        try:
            r = requests.get(nse_bhav.ARCHIVE_URL.format(ddmmyyyy=d.strftime("%d%m%Y")),
                             headers=HEADERS, timeout=30)
        except Exception:
            continue
        if r.status_code != 200 or "SYMBOL" not in r.text[:200]:
            continue
        for row in csv.DictReader(io.StringIO(r.text)):
            row = {(k or "").strip(): (v or "").strip() for k, v in row.items()}
            if row.get("SERIES") in TRUST_SERIES:
                trusts.add(row["SYMBOL"])
    return trusts


def _int_or_none(v):
    try:
        return int(str(v).strip())
    except (TypeError, ValueError):
        return None


def _download(symbol, period):
    return yf.download(f"{symbol}.NS", period=period, interval="1d",
                       auto_adjust=True, progress=False, threads=False)


def _backfill(s, iid, symbol, period="max", cutoff=None):
    """Write every completed EOD bar for one symbol. Returns bars written, or
    None when Yahoo has no ticker yet (brand-new listing)."""
    cutoff = cutoff or _cutoff_date()
    df = _download(symbol, period)
    # A stock listed today has a ticker but only a day or two of history, and
    # Yahoo rejects the long periods outright ("must be one of: 1d, 5d")
    # instead of returning a short frame. Fall back rather than lose the bars.
    if df is None or df.empty:
        for fallback in ("5d", "1d"):
            if fallback == period:
                continue
            df = _download(symbol, fallback)
            if df is not None and not df.empty:
                log.info(f"    {symbol}: '{period}' unavailable (new listing) — used '{fallback}'")
                break
    if df is None or df.empty:
        return None
    if getattr(df.columns, "nlevels", 1) > 1:
        df.columns = df.columns.get_level_values(0)

    n = 0
    for ts, r in df.iterrows():
        if ts.date() > cutoff:      # unfinished session — partial bar
            continue
        try:
            o, h, l, c = float(r["Open"]), float(r["High"]), float(r["Low"]), float(r["Close"])
            v = int(r["Volume"]) if r["Volume"] == r["Volume"] else 0
        except Exception:
            continue
        if any(x != x for x in (o, h, l, c)):   # NaN guard
            continue
        s.execute(text(
            "INSERT OR REPLACE INTO ohlcv_eod (instrument_id, time, open, high, low, close, volume) "
            "VALUES (:iid,:t,:o,:h,:l,:c,:v)"
        ), {"iid": iid, "t": ts.strftime("%Y-%m-%d"), "o": o, "h": h, "l": l, "c": c, "v": v})
        n += 1
    return n


def _write_bars(s, iid, bars):
    """Write (date_str, o, h, l, c, v) rows from the NSE fallback.

    OR IGNORE, not OR REPLACE: these are raw prices and Yahoo's are adjusted,
    so an NSE bar must never overrule one Yahoo already provided (see
    nse_bhav.py). Fills gaps only.
    """
    n = 0
    for t, o, h, l, c, v in bars:
        res = s.execute(text(
            "INSERT OR IGNORE INTO ohlcv_eod (instrument_id, time, open, high, low, close, volume) "
            "VALUES (:iid,:t,:o,:h,:l,:c,:v)"
        ), {"iid": iid, "t": t, "o": o, "h": h, "l": l, "c": c, "v": v})
        n += res.rowcount or 0
    return n


def _nse_fallback(s, pending, cutoff, days=30):
    """Fill symbols Yahoo couldn't serve from the exchange's own bhavcopy.

    `pending` is {symbol: instrument_id}. The archive is per-day, so it's
    walked ONCE for the whole batch rather than per symbol.
    """
    if not pending:
        return 0, []
    log.info(f"NSE fallback: {len(pending)} symbol(s) Yahoo had no data for "
             f"— reading bhavcopy back {days} days: {', '.join(sorted(pending))}")
    found = nse_bhav.fetch_bars(pending.keys(), days=days, cutoff=cutoff)

    written = 0
    for sym, iid in pending.items():
        bars = found.get(sym)
        if not bars:
            continue
        n = _write_bars(s, iid, bars)
        s.commit()
        written += n
        log.info(f"    {sym}: {n} bars from NSE ({bars[0][0]} → {bars[-1][0]})")
    still_empty = sorted(set(pending) - set(found))
    return written, still_empty


def sync_listings(dry_run=False, include_bz=False, period="max",
                  nse_fallback=True, nse_days=30, trusts=True):
    master = _fetch_master()
    cutoff = _cutoff_date()
    log.info(f"NSE mainboard master: {len(master)} listings")
    log.info(f"EOD cutoff = {cutoff} (today's bar is written only after 15:45 IST)")

    engine = create_engine(_db_url(), pool_pre_ping=True,
                           connect_args={"timeout": 60} if _db_url().startswith("sqlite") else {})
    with Session(engine) as s:
        # Compare against EVERY symbol, not just EQ: `symbol` is uniquely
        # indexed, so a name already held by another segment (e.g. the MCX
        # index ENERGY) would collide on insert rather than be "missing".
        existing = {r[0] for r in s.execute(text("SELECT symbol FROM instruments"))}

        missing, skipped_bz = [], []
        for row in master:
            sym = row["SYMBOL"]
            if sym in existing:
                continue
            if row.get("SERIES") in SUSPENDED_SERIES and not include_bz:
                skipped_bz.append(sym)
                continue
            missing.append(row)

        # REITs / InvITs live outside the equity master — add them here or they
        # stay invisible forever. Bhavcopy carries no company name, so the
        # symbol doubles as the name (same as the ETF rows already in the DB).
        if trusts:
            for sym in sorted(_fetch_trusts(cutoff) - existing):
                missing.append({"SYMBOL": sym, "NAME OF COMPANY": sym,
                                "SERIES": "RR/IV", "DATE OF LISTING": "—",
                                "ISIN NUMBER": "", "MARKET LOT": ""})

        if skipped_bz:
            log.info(f"Skipping {len(skipped_bz)} suspended (BZ) symbols: {', '.join(sorted(skipped_bz))}")
        if not missing:
            log.info("Nothing to add — every mainboard listing is already in the DB.")
            return 0, 0, []

        log.info(f"Missing from DB: {len(missing)}")
        for row in missing:
            log.info(f"  {row['SYMBOL']:12s} | {row['NAME OF COMPANY'][:45]:45s} "
                     f"| listed {row['DATE OF LISTING']} | {row['SERIES']}")
        if dry_run:
            log.info("--dry-run: no changes written.")
            return 0, 0, []

        added, bars_total, pending = 0, 0, {}
        for row in missing:
            sym = row["SYMBOL"]
            # BZ names are suspended: insert inactive so they stay out of scans.
            active = 0 if row.get("SERIES") in SUSPENDED_SERIES else 1
            s.execute(text(
                "INSERT INTO instruments (symbol, name, exchange, segment, isin, lot_size, "
                "is_active, is_intraday) "
                "VALUES (:sym, :name, 'NSE', 'EQ', :isin, :lot, :active, 0)"
            ), {
                "sym": sym,
                "name": row["NAME OF COMPANY"] or sym,
                "isin": row.get("ISIN NUMBER") or None,
                "lot": _int_or_none(row.get("MARKET LOT")),
                "active": active,
            })
            s.commit()
            iid = s.execute(text("SELECT id FROM instruments WHERE symbol = :s"), {"s": sym}).fetchone()[0]
            added += 1

            n = _backfill(s, iid, sym, period, cutoff)
            s.commit()
            if n:
                bars_total += n
                log.info(f"  + {sym} (id={iid}) — inserted, {n} bars from Yahoo")
            else:
                # Nothing usable from Yahoo (no ticker, or only an unfinished
                # bar) — hand it to the exchange feed below.
                pending[sym] = iid
                log.info(f"  + {sym} (id={iid}) — inserted, no Yahoo data")

        still_empty = sorted(pending)
        if pending and nse_fallback:
            n, still_empty = _nse_fallback(s, pending, cutoff, nse_days)
            bars_total += n

        log.info(f"Done. instruments added={added}, bars written={bars_total}, "
                 f"still without data={len(still_empty)}")
        if still_empty:
            log.info(f"  no data from either source (daily_sync will retry): {', '.join(still_empty)}")
        return added, bars_total, still_empty


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s — %(message)s")
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="report what's missing, write nothing")
    ap.add_argument("--include-bz", action="store_true", help="also add suspended BZ names (as inactive)")
    ap.add_argument("--period", default="max", help="yfinance history period (default: max)")
    ap.add_argument("--no-nse-fallback", action="store_true",
                    help="don't fall back to the NSE bhavcopy when Yahoo has no data")
    ap.add_argument("--nse-days", type=int, default=30,
                    help="days of bhavcopy to walk back in the fallback (default: 30)")
    args = ap.parse_args()
    sync_listings(dry_run=args.dry_run, include_bz=args.include_bz, period=args.period,
                  nse_fallback=not args.no_nse_fallback, nse_days=args.nse_days)
