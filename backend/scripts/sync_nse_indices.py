"""Chartix — official NSE index EOD sync.

Pulls the NSE daily index snapshot (ind_close_all_DDMMYYYY.csv, public archive)
and upserts OHLC for every NSE index we track, matched by index *name*.
This is the exchange's own data, so it covers indices Yahoo lags on or lacks
entirely (Midcap 100, Next 50, thematic/sector indices, …).

Run standalone:  venv/bin/python scripts/sync_nse_indices.py --days 7
Also called from daily_sync.py as a post-step.
"""
import csv
import io
import logging
import os
import sys
from datetime import date, timedelta

import requests
from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
from app.config import get_settings  # noqa: E402

log = logging.getLogger(__name__)

ARCHIVE_URL = "https://archives.nseindia.com/content/indices/ind_close_all_{ddmmyyyy}.csv"
HEADERS = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"}


def _db_url():
    url = get_settings().DATABASE_URL.replace("+aiosqlite", "").replace("+asyncpg", "")
    return url


def _num(v):
    try:
        v = (v or "").replace(",", "").strip()
        return float(v) if v and v != "-" else None
    except Exception:
        return None


def sync_indices(days=7):
    engine = create_engine(_db_url(), pool_pre_ping=True,
                           connect_args={"timeout": 60} if _db_url().startswith("sqlite") else {})
    with Session(engine) as s:
        name_to_id = {
            (name or "").strip().lower(): iid
            for iid, name in s.execute(text(
                "SELECT id, name FROM instruments WHERE segment='IND' AND is_active=1"
            ))
        }
        if not name_to_id:
            log.warning("no active IND instruments"); return 0

        written = 0
        today = date.today()
        for back in range(days):
            d = today - timedelta(days=back)
            if d.weekday() >= 5:  # weekend — no file
                continue
            url = ARCHIVE_URL.format(ddmmyyyy=d.strftime("%d%m%Y"))
            try:
                r = requests.get(url, headers=HEADERS, timeout=30)
            except Exception as e:
                log.info(f"{d}: fetch failed ({e})"); continue
            if r.status_code != 200 or len(r.content) < 500:
                continue  # holiday / not published yet

            day_rows = 0
            for row in csv.DictReader(io.StringIO(r.text)):
                nm = (row.get("Index Name") or "").strip().lower()
                iid = name_to_id.get(nm)
                if not iid:
                    continue
                o = _num(row.get("Open Index Value"))
                h = _num(row.get("High Index Value"))
                l = _num(row.get("Low Index Value"))
                c = _num(row.get("Closing Index Value"))
                v = _num(row.get("Volume")) or 0
                if c is None:
                    continue
                # some thematic indices publish close-only rows
                o = o if o is not None else c
                h = h if h is not None else max(o, c)
                l = l if l is not None else min(o, c)
                s.execute(text(
                    "INSERT OR REPLACE INTO ohlcv_eod (instrument_id, time, open, high, low, close, volume) "
                    "VALUES (:iid,:t,:o,:h,:l,:c,:v)"
                ), {"iid": iid, "t": d.strftime("%Y-%m-%d"), "o": o, "h": h, "l": l, "c": c, "v": int(v)})
                day_rows += 1
            s.commit()
            if day_rows:
                log.info(f"{d}: {day_rows} indices upserted from NSE csv")
                written += day_rows
        return written


if __name__ == "__main__":
    import argparse
    logging.basicConfig(level=logging.INFO, format="%(asctime)s — %(message)s")
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=7)
    args = ap.parse_args()
    n = sync_indices(args.days)
    log.info(f"Done. {n} index bars written.")
