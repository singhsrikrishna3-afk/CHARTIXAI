"""PEESTOCK — Backfill data for missing or incomplete Nifty 50 constituent stocks."""

import os
import sys
import logging
import time
import requests
import pandas as pd
import yfinance as yf
from datetime import date
from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session

# Add backend to path
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from app.config import get_settings

logging.basicConfig(level=logging.INFO, format="%(asctime)s — %(levelname)s — %(message)s")
logger = logging.getLogger(__name__)

settings = get_settings()

SYNC_DB_URL = settings.DATABASE_URL.replace("+asyncpg", "").replace(
    "+aiosqlite", ""
).replace("postgresql+psycopg2", "postgresql")

def get_engine():
    kwargs = {}
    if SYNC_DB_URL.startswith("sqlite"):
        kwargs["connect_args"] = {"timeout": 30}
    return create_engine(SYNC_DB_URL, pool_pre_ping=True, **kwargs)

def backfill_stocks(engine, symbols, period="5y"):
    logger.info(f"Backfilling {period} historical data for {symbols} from Yahoo Finance...")
    
    with Session(engine) as session:
        # Get instrument ids
        instruments = session.execute(
            text("SELECT id, symbol FROM instruments WHERE segment = 'EQ' AND is_active = 1")
        ).fetchall()
        sym_to_id = {sym: iid for iid, sym in instruments}
        
    for sym in symbols:
        if sym not in sym_to_id:
            logger.warning(f"Symbol {sym} not found in database. Skipping.")
            continue
            
        iid = sym_to_id[sym]
        ticker = f"{sym}.NS"
        
        # Try up to 3 times
        df = pd.DataFrame()
        for attempt in range(3):
            logger.info(f"Downloading {ticker} (attempt {attempt + 1})...")
            try:
                df = yf.download(
                    ticker,
                    period=period,
                    interval="1d",
                    auto_adjust=True,
                    progress=False
                )
                if not df.empty:
                    break
            except Exception as e:
                logger.error(f"Attempt {attempt + 1} failed for {ticker}: {e}")
            time.sleep(2)
            
        if df.empty:
            logger.warning(f"No data returned for {ticker} after all attempts.")
            continue
            
        try:
            # Handle MultiIndex
            if isinstance(df.columns, pd.MultiIndex):
                df.columns = df.columns.droplevel(1)
                
            df = df.dropna(subset=["Open", "High", "Low", "Close"]).copy()
            logger.info(f"Found {len(df)} bars for {ticker}")
            
            records = []
            for dt, row in df.iterrows():
                records.append({
                    "time": dt.date(),
                    "iid": iid,
                    "o": float(row["Open"]),
                    "h": float(row["High"]),
                    "l": float(row["Low"]),
                    "c": float(row["Close"]),
                    "v": int(row["Volume"]) if pd.notnull(row["Volume"]) else 0,
                })
                
            if records:
                with Session(engine) as session:
                    session.execute(
                        text(
                            "INSERT INTO ohlcv_eod (time, instrument_id, open, high, low, close, volume) "
                            "VALUES (:time, :iid, :o, :h, :l, :c, :v) "
                            "ON CONFLICT (instrument_id, time) DO UPDATE SET "
                            "open=EXCLUDED.open, high=EXCLUDED.high, low=EXCLUDED.low, "
                            "close=EXCLUDED.close, volume=EXCLUDED.volume"
                        ),
                        records
                    )
                    session.commit()
                logger.info(f"Successfully backfilled {len(records)} EOD records for {sym}")
        except Exception as e:
            logger.error(f"Failed to backfill {sym}: {e}")

    # Post-backfill spike cleanup to resolve Yahoo Finance data freak errors
    logger.info("Cleaning non-positive prices (<= 0) and high/low spikes from database...")
    with Session(engine) as session:
        session.execute(text("""
            UPDATE ohlcv_eod
            SET open = CASE WHEN open <= 0 THEN 0.01 ELSE open END,
                high = CASE WHEN high <= 0 THEN 0.01 ELSE high END,
                low = CASE WHEN low <= 0 THEN 0.01 ELSE low END,
                close = CASE WHEN close <= 0 THEN 0.01 ELSE close END
            WHERE open <= 0 OR high <= 0 OR low <= 0 OR close <= 0
        """))
        session.execute(text("""
            UPDATE ohlcv_eod
            SET high = CASE WHEN open > close THEN open * 1.05 ELSE close * 1.05 END
            WHERE high > 1.25 * close AND high > 1.25 * open AND open > 0 AND close > 0
        """))
        session.execute(text("""
            UPDATE ohlcv_eod
            SET low = CASE WHEN open < close THEN open * 0.95 ELSE close * 0.95 END
            WHERE low < 0.75 * close AND low < 0.75 * open AND low > 0 AND open > 0 AND close > 0
        """))
        session.commit()

def run_scans(settings):
    logger.info("Running pattern and trendline scans for the backfilled stocks...")
    venv_python = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "venv", "bin", "python")
    scan_script = (
        "import sys; "
        "sys.path.append('backend/app/workers'); "
        "sys.path.append('app/workers'); "
        "from tasks_eod import run_pattern_scan, run_trendline_scan; "
        "run_pattern_scan(); "
        "run_trendline_scan()"
    )
    import subprocess
    env = os.environ.copy()
    env["DATABASE_URL"] = settings.DATABASE_URL
    subprocess.run([venv_python, "-c", scan_script], env=env)
    logger.info("Scans complete.")

def main():
    engine = get_engine()
    missing_symbols = ["BEL", "INDIGO", "TRENT"]
    
    # Verify these exist as instruments
    with Session(engine) as session:
        for sym in missing_symbols:
            result = session.execute(
                text("SELECT id FROM instruments WHERE symbol = :sym"),
                {"sym": sym}
            ).fetchone()
            if not result:
                logger.info(f"Creating missing instrument {sym}")
                session.execute(
                    text(
                        "INSERT INTO instruments (symbol, name, exchange, segment, is_active) "
                        "VALUES (:sym, :name, 'NSE', 'EQ', 1)"
                    ),
                    {"sym": sym, "name": sym}
                )
        session.commit()
        
    backfill_stocks(engine, missing_symbols, period="5y")
    run_scans(settings)
    logger.info("Done backfilling missing Nifty 50 constituents.")

if __name__ == "__main__":
    main()
