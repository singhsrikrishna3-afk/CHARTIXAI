"""Chartix — NSE delivery-volume sync.

Pulls the NSE full bhavcopy with delivery data (sec_bhavdata_full_DDMMYYYY.csv,
public archive) and writes DELIV_QTY / DELIV_PER onto the matching ohlcv_eod
rows. Delivery volume is the institutional-conviction proxy Yahoo doesn't
carry: high delivery % means buyers took the shares home rather than
intraday-flipping them.

Only updates rows that already exist (daily_sync writes the OHLCV first);
EQ/BE series only, matched by symbol.

Run standalone:  venv/bin/python scripts/sync_delivery.py --days 7
Backfill:        venv/bin/python scripts/sync_delivery.py --days 180
Also called from daily_sync.py as a post-step.
"""
import argparse
import csv
import io
import logging
import os
import sys
import time as _time
from datetime import date, datetime, timedelta

import requests
from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
from app.config import get_settings  # noqa: E402

log = logging.getLogger(__name__)

ARCHIVE_URL = "https://archives.nseindia.com/products/content/sec_bhavdata_full_{ddmmyyyy}.csv"
HEADERS = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"}
SERIES_OK = {"EQ", "BE", "BZ"}


def _db_url():
    return get_settings().DATABASE_URL.replace("+aiosqlite", "").replace("+asyncpg", "")


def _num(v):
    try:
        v = (v or "").replace(",", "").strip()
        return float(v) if v and v != "-" else None
    except Exception:
        return None


def _fetch_day(d: date):
    """Rows of (symbol, deliv_qty, deliv_per) for one trading day, or None if
    the archive has no file (weekend/holiday)."""
    url = ARCHIVE_URL.format(ddmmyyyy=d.strftime("%d%m%Y"))
    r = requests.get(url, headers=HEADERS, timeout=30)
    if r.status_code != 200 or not r.text or "SYMBOL" not in r.text[:200]:
        return None
    out = []
    for row in csv.DictReader(io.StringIO(r.text)):
        row = {(k or "").strip(): (v or "").strip() for k, v in row.items()}
        if row.get("SERIES") not in SERIES_OK:
            continue
        dq, dp = _num(row.get("DELIV_QTY")), _num(row.get("DELIV_PER"))
        if dq is None and dp is None:
            continue
        out.append((row["SYMBOL"], int(dq) if dq is not None else None, dp))
    return out


def sync_delivery(days=7, pause=0.6):
    engine = create_engine(_db_url(), pool_pre_ping=True,
                           connect_args={"timeout": 60} if _db_url().startswith("sqlite") else {})
    with Session(engine) as s:
        sym_to_id = {
            sym: iid for iid, sym in s.execute(text(
                "SELECT id, symbol FROM instruments WHERE segment='EQ' AND is_active=1"
            ))
        }
        if not sym_to_id:
            log.warning("no active EQ instruments")
            return 0

        written = 0
        today = date.today()
        for back in range(days):
            d = today - timedelta(days=back)
            if d.weekday() >= 5:            # weekend — no bhavcopy
                continue
            try:
                rows = _fetch_day(d)
            except Exception as e:
                log.warning(f"{d}: fetch failed ({e})")
                continue
            if not rows:
                continue
            day_s = d.strftime("%Y-%m-%d")
            params = [
                {"dq": dq, "dp": dp, "iid": sym_to_id[sym], "t": day_s}
                for sym, dq, dp in rows if sym in sym_to_id
            ]
            if params:
                res = s.execute(text(
                    "UPDATE ohlcv_eod SET delivery_qty = :dq, delivery_per = :dp "
                    "WHERE instrument_id = :iid AND time = :t"
                ), params)
                s.commit()
                n = res.rowcount if res.rowcount and res.rowcount > 0 else len(params)
                written += n
                log.info(f"{d}: {n} rows updated")
            _time.sleep(pause)              # be polite to the NSE archive
        return written


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=7, help="calendar days to walk back")
    args = ap.parse_args()
    n = sync_delivery(days=args.days)
    print(f"done: {n} ohlcv_eod rows got delivery data")
