"""Add one NSE stock as an instrument and backfill its EOD history from yfinance.

Usage:
    venv/bin/python scripts/add_single_stock.py ANDHRAPET "Andhra Petrochemicals" "Chemicals"
"""
import sys
import os
import logging

import yfinance as yf
from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
from app.config import get_settings  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(message)s")
log = logging.getLogger(__name__)


def main(symbol, name=None, sector=None, period="5y", yticker=None):
    symbol = symbol.upper()
    name = name or symbol
    yticker = yticker or f"{symbol}.NS"
    url = get_settings().DATABASE_URL
    if url.startswith("sqlite") and "?" not in url:
        url += "?timeout=30"
    engine = create_engine(url, pool_pre_ping=True,
                           connect_args={"timeout": 30} if url.startswith("sqlite") else {})

    with Session(engine) as s:
        row = s.execute(text("SELECT id FROM instruments WHERE symbol = :sym"), {"sym": symbol}).fetchone()
        if row:
            iid = row[0]
            log.info(f"{symbol} already exists (id={iid}). Will (re)backfill history.")
        else:
            s.execute(text(
                "INSERT INTO instruments (symbol, name, sector, segment, is_active, is_intraday) "
                "VALUES (:sym, :name, :sector, 'EQ', 1, 0)"
            ), {"sym": symbol, "name": name, "sector": sector})
            s.commit()
            iid = s.execute(text("SELECT id FROM instruments WHERE symbol = :sym"), {"sym": symbol}).fetchone()[0]
            log.info(f"Inserted {symbol} (id={iid}).")

        log.info(f"Downloading {period} of daily data for {yticker} …")
        df = yf.download(yticker, period=period, interval="1d",
                         auto_adjust=True, progress=False)
        if df is None or df.empty:
            log.error(f"No data returned for {yticker} — symbol may be wrong or delisted.")
            return

        # flatten possible multiindex columns
        if hasattr(df.columns, "nlevels") and df.columns.nlevels > 1:
            df.columns = df.columns.get_level_values(0)

        inserted = 0
        for ts, r in df.iterrows():
            try:
                o, h, l, c = float(r["Open"]), float(r["High"]), float(r["Low"]), float(r["Close"])
                v = int(r["Volume"]) if r["Volume"] == r["Volume"] else 0
            except Exception:
                continue
            if any(x != x for x in (o, h, l, c)):  # NaN guard
                continue
            s.execute(text(
                "INSERT OR REPLACE INTO ohlcv_eod (instrument_id, time, open, high, low, close, volume) "
                "VALUES (:iid, :t, :o, :h, :l, :c, :v)"
            ), {"iid": iid, "t": ts.strftime("%Y-%m-%d"), "o": o, "h": h, "l": l, "c": c, "v": v})
            inserted += 1
        s.commit()
        log.info(f"Backfilled {inserted} EOD bars for {symbol}.")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("usage: add_single_stock.py SYMBOL [name] [sector]")
        sys.exit(1)
    main(sys.argv[1],
         sys.argv[2] if len(sys.argv) > 2 else None,
         sys.argv[3] if len(sys.argv) > 3 else None,
         yticker=sys.argv[4] if len(sys.argv) > 4 else None)
