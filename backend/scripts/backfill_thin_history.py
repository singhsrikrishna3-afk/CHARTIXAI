"""Deep-backfill active EQ stocks that are stuck with thin history.

Symptom this fixes: ~600 active EQ stocks had only ~20–30 bars (e.g. ABCOTS,
ABINFRA), even though Yahoo carries a full year+ — they were added to
`instruments` but never got a historical backfill, and daily_sync only appends
the last few days each run, so they never deepened. These stocks silently drop
out of Stage Analysis (needs 170 bars for a 150-DMA) and undercount Market
Breadth, which is why our universe looked far smaller than NSE's.

Strategy per thin stock (fewer than `--min-bars` rows):
  1. Yahoo period='max' (bulk-chunked). Upsert every completed bar.
  2. Any still-thin afterwards → NSE bhavcopy archive fallback (raw prices,
     INSERT OR IGNORE so it only fills gaps, never overwrites Yahoo bars).

Same cutoff rule as daily_sync — today's bar is written only after 15:45 IST.

Usage:  venv/bin/python scripts/backfill_thin_history.py [--min-bars 170] [--dry-run]
"""
import argparse
import os
import sys

import yfinance as yf
from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session

sys.path.insert(0, os.path.abspath(os.path.dirname(__file__)))
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
from daily_sync import _upsert, _cutoff_date, _yf_ticker, log, DB_URL  # noqa: E402
import nse_bhav  # noqa: E402


def run(min_bars=170, dry_run=False):
    cutoff = _cutoff_date()
    engine = create_engine(DB_URL, pool_pre_ping=True,
                           connect_args={"timeout": 60} if DB_URL.startswith("sqlite") else {})
    with Session(engine) as s:
        thin = s.execute(text(
            "SELECT i.id, i.symbol, COUNT(o.time) AS n "
            "FROM instruments i LEFT JOIN ohlcv_eod o ON o.instrument_id = i.id "
            "WHERE i.segment='EQ' AND i.is_active=1 "
            "GROUP BY i.id HAVING n < :mb ORDER BY n"
        ), {"mb": min_bars}).fetchall()
        log.info(f"thin-history active EQ (<{min_bars} bars): {len(thin)}")
        if dry_run:
            for iid, sym, n in thin[:30]:
                log.info(f"  {sym:12s} {n} bars")
            log.info("--dry-run: nothing written.")
            return 0, 0

        # symbol → id, and the .NS ticker (BSE-only names handled by _yf_ticker)
        tick_to_id, id_to_sym = {}, {}
        for iid, sym, n in thin:
            t = _yf_ticker(sym, "EQ")
            if t:
                tick_to_id[t] = iid
                id_to_sym[iid] = sym

        total, deepened = 0, 0
        tickers = list(tick_to_id)
        for i in range(0, len(tickers), 200):
            chunk = tickers[i:i + 200]
            log.info(f"Yahoo max chunk {i // 200 + 1}: {len(chunk)} tickers")
            try:
                data = yf.download(chunk, period="max", interval="1d", group_by="ticker",
                                   auto_adjust=True, threads=True, progress=False)
            except Exception as e:
                log.warning(f"chunk failed: {e}"); continue
            for t in chunk:
                try:
                    sub = data[t] if len(chunk) > 1 else data
                except Exception:
                    continue
                n = _upsert(s, tick_to_id[t], sub, cutoff)
                total += n
                if n > 30:
                    deepened += 1
            s.commit()

        # NSE archive fallback for anything still thin (Yahoo had nothing useful)
        still = s.execute(text(
            "SELECT i.id, i.symbol, COUNT(o.time) AS n "
            "FROM instruments i LEFT JOIN ohlcv_eod o ON o.instrument_id = i.id "
            "WHERE i.segment='EQ' AND i.is_active=1 "
            "GROUP BY i.id HAVING n < :mb"
        ), {"mb": min_bars}).fetchall()
        pending = {sym: iid for iid, sym, n in still}
        if pending:
            log.info(f"NSE archive fallback for {len(pending)} still-thin symbols "
                     f"(walking back ~2 years)")
            from datetime import date
            found = 0
            for d, hit in nse_bhav.walk(pending.keys(), date(2024, 7, 1), cutoff, pause=0.5):
                day = d.strftime("%Y-%m-%d")
                for sym, (o, h, l, c, v) in hit.items():
                    res = s.execute(text(
                        "INSERT OR IGNORE INTO ohlcv_eod (instrument_id, time, open, high, low, close, volume) "
                        "VALUES (:iid,:t,:o,:h,:l,:c,:v)"
                    ), {"iid": pending[sym], "t": day, "o": o, "h": h, "l": l, "c": c, "v": v})
                    n = res.rowcount or 0
                    total += n
                    found += n
                s.commit()
            log.info(f"NSE fallback added {found} bars")

        log.info(f"Done. {deepened} stocks meaningfully deepened, {total} bars written.")
        return deepened, total


if __name__ == "__main__":
    import logging
    logging.basicConfig(level=logging.INFO, format="%(asctime)s — %(message)s")
    ap = argparse.ArgumentParser()
    ap.add_argument("--min-bars", type=int, default=170)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    run(min_bars=args.min_bars, dry_run=args.dry_run)
