"""Chartix — deep history backfill straight from the NSE archive.

For instruments Yahoo has no ticker for at all (REITs and InvITs especially),
the exchange's bhavcopy is the ONLY source of history. It's one file per
trading day, so depth costs requests: ~250 files per year, ~0.35MB each.

Streams via nse_bhav.walk (no per-day cache) and commits as it goes, so a
multi-year walk stays flat in memory instead of holding thousands of days of
~2,700 symbols — this box's failure mode is OOM.

Writes INSERT OR IGNORE: bhavcopy prices are raw, Yahoo's are adjusted, so an
NSE bar never overrules one Yahoo already gave (see nse_bhav.py).

The archive bottoms out around 2020-01-02 — nothing in 2019.

Usage:
    # everything active that Yahoo can't serve, as deep as the archive goes
    venv/bin/python scripts/backfill_nse_history.py --missing-yahoo --start 2020-01-02

    # specific symbols
    venv/bin/python scripts/backfill_nse_history.py --symbols NHIT,CUBEINVIT --start 2022-01-01
"""

import argparse
import logging
import os
import sys
from datetime import date, datetime, time as _time, timedelta, timezone

from sqlalchemy import bindparam, create_engine, text
from sqlalchemy.orm import Session

sys.path.insert(0, os.path.abspath(os.path.dirname(__file__)))
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
import nse_bhav  # noqa: E402
from app.config import get_settings  # noqa: E402

log = logging.getLogger(__name__)

IST = timezone(timedelta(hours=5, minutes=30))
_MARKET_CLOSE = _time(15, 45)


def _cutoff_date():
    now = datetime.now(IST)
    return now.date() if now.time() >= _MARKET_CLOSE else (now.date() - timedelta(days=1))


def _db_url():
    return get_settings().DATABASE_URL.replace("+aiosqlite", "").replace("+asyncpg", "")


def _parse_date(s):
    return datetime.strptime(s, "%Y-%m-%d").date()


def backfill(symbols=None, missing_yahoo=False, start=date(2020, 1, 2), pause=0.6):
    cutoff = _cutoff_date()
    engine = create_engine(_db_url(), pool_pre_ping=True,
                           connect_args={"timeout": 60} if _db_url().startswith("sqlite") else {})
    with Session(engine) as s:
        if missing_yahoo:
            # Active EQ rows with no bar in the last 30 days are the ones Yahoo
            # isn't serving; anything Yahoo covers is kept current by daily_sync.
            rows = s.execute(text(
                "SELECT i.symbol, i.id FROM instruments i "
                "WHERE i.segment='EQ' AND i.is_active=1 AND NOT EXISTS ("
                "  SELECT 1 FROM ohlcv_eod o WHERE o.instrument_id=i.id AND o.time >= :recent)"
            ), {"recent": (cutoff - timedelta(days=30)).strftime("%Y-%m-%d")}).fetchall()
            targets = {sym: iid for sym, iid in rows}
        else:
            if not symbols:
                log.error("Pass --symbols or --missing-yahoo.")
                return 0
            rows = s.execute(
                text("SELECT symbol, id FROM instruments WHERE symbol IN :syms")
                .bindparams(bindparam("syms", expanding=True)),
                {"syms": list(symbols)},
            ).fetchall()
            targets = {sym: iid for sym, iid in rows}
            for miss in set(symbols) - set(targets):
                log.warning(f"{miss}: not in instruments — skipped")

        if not targets:
            log.info("Nothing to backfill.")
            return 0

        span_days = (cutoff - start).days
        log.info(f"Backfilling {len(targets)} symbols from NSE: {', '.join(sorted(targets))}")
        log.info(f"Walking {start} → {cutoff} (~{span_days} calendar days, "
                 f"~{int(span_days * 5 / 7)} files, est. {span_days * 5 / 7 * (pause + 0.4) / 60:.0f} min)")

        written, days_seen, last_log = 0, 0, datetime.now()
        for d, hit in nse_bhav.walk(targets.keys(), start, cutoff, pause=pause):
            day_s = d.strftime("%Y-%m-%d")
            for sym, (o, h, l, c, v) in hit.items():
                res = s.execute(text(
                    "INSERT OR IGNORE INTO ohlcv_eod (instrument_id, time, open, high, low, close, volume) "
                    "VALUES (:iid,:t,:o,:h,:l,:c,:v)"
                ), {"iid": targets[sym], "t": day_s, "o": o, "h": h, "l": l, "c": c, "v": v})
                written += res.rowcount or 0
            days_seen += 1
            s.commit()
            if (datetime.now() - last_log).total_seconds() > 60:
                log.info(f"  … at {day_s}, {days_seen} trading days read, {written} bars written")
                last_log = datetime.now()

        log.info(f"Done. {days_seen} trading days read, {written} bars written.")
        return written


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s — %(message)s")
    ap = argparse.ArgumentParser()
    ap.add_argument("--symbols", help="comma-separated symbols")
    ap.add_argument("--missing-yahoo", action="store_true",
                    help="auto-pick active EQ rows with no recent bar (i.e. Yahoo can't serve them)")
    ap.add_argument("--start", default="2020-01-02", help="earliest date to walk back to (archive floor ~2020-01-02)")
    ap.add_argument("--pause", type=float, default=0.6, help="seconds between archive requests")
    args = ap.parse_args()
    syms = [x.strip().upper() for x in args.symbols.split(",")] if args.symbols else None
    backfill(symbols=syms, missing_yahoo=args.missing_yahoo,
             start=_parse_date(args.start), pause=args.pause)
