"""PEESTOCK — Seed and backfill commodities (COMEX USD & MCX INR) and forex segments from IPO/inception."""

import os
import sys
import time
import logging
import pandas as pd
import yfinance as yf
from datetime import date, datetime
from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session

# Add backend to path
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from app.config import get_settings
from app.models.models import Base

logging.basicConfig(level=logging.INFO, format="%(asctime)s — %(levelname)s — %(message)s")
logger = logging.getLogger(__name__)

settings = get_settings()
SYNC_DB_URL = settings.DATABASE_URL.replace("+asyncpg", "").replace(
    "+aiosqlite", ""
).replace("postgresql+psycopg2", "postgresql")

COMMODITIES_INDEX = {
    "symbol": "COMMODITIES",
    "name": "Commodities",
    "constituents": [
        {"symbol": "GC=F", "name": "Gold COMEX (USD)", "exchange": "COMEX", "segment": "COMM"},
        {"symbol": "XAUINR=X", "name": "Gold MCX Spot (INR)", "exchange": "MCX", "segment": "COMM"},
        {"symbol": "SI=F", "name": "Silver COMEX (USD)", "exchange": "COMEX", "segment": "COMM"},
        {"symbol": "XAGINR=X", "name": "Silver MCX Spot (INR)", "exchange": "MCX", "segment": "COMM"},
        {"symbol": "CL=F", "name": "Crude Oil NYMEX (USD)", "exchange": "NYMEX", "segment": "COMM"},
        {"symbol": "NG=F", "name": "Natural Gas NYMEX (USD)", "exchange": "NYMEX", "segment": "COMM"},
        {"symbol": "HG=F", "name": "Copper COMEX (USD)", "exchange": "COMEX", "segment": "COMM"},
        {"symbol": "ALI=F", "name": "Aluminium LME (USD)", "exchange": "LME", "segment": "COMM"},
        {"symbol": "ZNC=F", "name": "Zinc LME (USD)", "exchange": "LME", "segment": "COMM"},
        {"symbol": "LED=F", "name": "Lead LME (USD)", "exchange": "LME", "segment": "COMM"}
    ]
}

FOREX_INDEX = {
    "symbol": "FOREX",
    "name": "Forex",
    "constituents": [
        {"symbol": "USDINR=X", "name": "USD/INR Spot", "exchange": "NSE", "segment": "FOREX"},
        {"symbol": "EURINR=X", "name": "EUR/INR Spot", "exchange": "NSE", "segment": "FOREX"},
        {"symbol": "GBPINR=X", "name": "GBP/INR Spot", "exchange": "NSE", "segment": "FOREX"},
        {"symbol": "JPYINR=X", "name": "JPY/INR Spot", "exchange": "NSE", "segment": "FOREX"},
        {"symbol": "EURUSD=X", "name": "EUR/USD Spot", "exchange": "NSE", "segment": "FOREX"},
        {"symbol": "GBPUSD=X", "name": "GBP/USD Spot", "exchange": "NSE", "segment": "FOREX"},
        {"symbol": "USDJPY=X", "name": "USD/JPY Spot", "exchange": "NSE", "segment": "FOREX"}
    ]
}

def get_engine():
    kwargs = {}
    if SYNC_DB_URL.startswith("sqlite"):
        kwargs["connect_args"] = {"timeout": 30}
    return create_engine(SYNC_DB_URL, pool_pre_ping=True, **kwargs)

def backfill_ohlcv(engine, iid, ticker, period="max"):
    """Download and ingest EOD data for a single instrument."""
    try:
        logger.info(f"Downloading historical EOD data from yfinance for ticker {ticker} (Period: {period})...")
        df = yf.download(ticker, period=period, interval="1d", auto_adjust=True, progress=False)
        if df.empty:
            logger.warning(f"No data returned for ticker {ticker}")
            return 0
            
        if isinstance(df.columns, pd.MultiIndex):
            df.columns = df.columns.droplevel(1)
        df = df.dropna(subset=["Open", "High", "Low", "Close"]).copy()
        
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
            return len(records)
    except Exception as e:
        logger.error(f"Error backfilling {ticker}: {e}")
    return 0

def main():
    engine = get_engine()
    
    # Ensure tables exist
    Base.metadata.create_all(engine)
    
    # 1. Process Commodities and Forex indices
    indices_to_process = [COMMODITIES_INDEX, FOREX_INDEX]
    symbol_to_id = {}
    total_mappings = 0
    total_backfilled_records = 0
    
    # We will identify new or modified tickers that need backfilling
    tickers_to_backfill = []
    
    for idx_meta in indices_to_process:
        idx_symbol = idx_meta["symbol"]
        idx_name = idx_meta["name"]
        constituents = idx_meta["constituents"]
        
        logger.info(f"Processing index: {idx_name} ({idx_symbol})...")
        
        # A. Register Index Instrument
        with Session(engine) as session:
            session.execute(
                text(
                    "INSERT INTO instruments (symbol, name, exchange, segment, is_active) "
                    "VALUES (:sym, :name, 'NSE', 'IND', 1) "
                    "ON CONFLICT (symbol) DO UPDATE SET is_active = 1"
                ),
                {"sym": idx_symbol, "name": idx_name}
            )
            session.commit()
            
            # Load Index ID
            res = session.execute(
                text("SELECT id FROM instruments WHERE symbol = :sym"),
                {"sym": idx_symbol}
            ).fetchone()
            index_id = res[0]
            symbol_to_id[idx_symbol] = index_id
            
            # Clear existing constituents for this index
            session.execute(
                text("DELETE FROM index_constituents WHERE index_id = :index_id"),
                {"index_id": index_id}
            )
            session.commit()

        # B. Register Constituent Instruments and Map them
        mapped_records = []
        for item in constituents:
            sym = item["symbol"]
            name = item["name"]
            exchange = item["exchange"]
            segment = item["segment"]
            
            with Session(engine) as session:
                session.execute(
                    text(
                        "INSERT INTO instruments (symbol, name, exchange, segment, is_active) "
                        "VALUES (:sym, :name, :exch, :seg, 1) "
                        "ON CONFLICT (symbol) DO UPDATE SET is_active = 1, name = :name, segment = :seg, exchange = :exch"
                    ),
                    {"sym": sym, "name": name, "exch": exchange, "seg": segment}
                )
                session.commit()
                
                # Load Instrument ID
                res_instr = session.execute(
                    text("SELECT id FROM instruments WHERE symbol = :sym"),
                    {"sym": sym}
                ).fetchone()
                instr_id = res_instr[0]
                symbol_to_id[sym] = instr_id
                
                # Check if it already has EOD history (more than 100 rows)
                history_count = session.execute(
                    text("SELECT COUNT(*) FROM ohlcv_eod WHERE instrument_id = :iid"),
                    {"iid": instr_id}
                ).scalar()
                
                if history_count < 100:
                    logger.info(f"Instrument {sym} has incomplete history ({history_count} rows). Adding to backfill list.")
                    tickers_to_backfill.append((instr_id, sym))
                
                mapped_records.append({
                    "index_id": index_id,
                    "instrument_id": instr_id
                })
        
        # Insert constituents mappings
        if mapped_records:
            with Session(engine) as session:
                session.execute(
                    text(
                        "INSERT OR IGNORE INTO index_constituents (index_id, instrument_id) "
                        "VALUES (:index_id, :instrument_id)"
                    ),
                    mapped_records
                )
                session.commit()
            logger.info(f"Mapped {len(mapped_records)} constituents for {idx_name}")
            total_mappings += len(mapped_records)

    # 2. Historical backfill for new or modified instruments (like XAUINR=X and XAGINR=X)
    if tickers_to_backfill:
        logger.info(f"Starting EOD backfill from inception for {len(tickers_to_backfill)} instruments...")
        for idx, (iid, sym) in enumerate(tickers_to_backfill):
            logger.info(f"[{idx+1}/{len(tickers_to_backfill)}] Backfilling EOD history for {sym}...")
            rows = backfill_ohlcv(engine, iid, sym, period="max")
            logger.info(f"Ingested {rows} EOD bars for {sym}")
            total_backfilled_records += rows
            time.sleep(0.5)
    else:
        logger.info("All instruments already have complete history. Skipping backfill.")

    # 3. Clean price spikes and non-positive prices
    logger.info("Running price anomalies cleanup on database...")
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
    logger.info("Database cleanup completed.")

    # 4. Trigger EOD scans for the new instruments
    logger.info("Triggering pattern and trendline scans to process new history...")
    venv_python = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "venv", "bin", "python")
    if not os.path.exists(venv_python):
        # Fallback to backend venv
        venv_python = os.path.join(os.path.dirname(os.path.abspath(__file__)), "venv", "bin", "python")
        
    scan_script = (
        "import sys; "
        "sys.path.append('app/workers'); "
        "from tasks_eod import run_pattern_scan, run_trendline_scan; "
        "run_pattern_scan(); "
        "run_trendline_scan()"
    )
    import subprocess
    env = os.environ.copy()
    env["DATABASE_URL"] = settings.DATABASE_URL
    
    # Run inside backend/ directory to ensure path resolutions are correct
    backend_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    subprocess.run([venv_python, "-c", scan_script], env=env, cwd=backend_dir)

    logger.info(f"🎉 Commodities and Forex Ingestion V2 Complete!")
    logger.info(f"Summary:")
    logger.info(f"  - Total Mappings Created: {total_mappings}")
    logger.info(f"  - EOD Price Bars Ingested: {total_backfilled_records}")

if __name__ == "__main__":
    main()
