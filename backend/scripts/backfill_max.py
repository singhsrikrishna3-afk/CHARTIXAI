"""PEESTOCK — Complete historical EOD backfill for all active stocks and indices from IPO/Commencement."""

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

INDEX_TICKERS = {
    "NIFTY_50": "^NSEI",
    "NIFTY_BANK": "^NSEBANK",
    "NIFTY_IT": "^CNXIT",
    "NIFTY_AUTO": "^CNXAUTO",
    "NIFTY_FMCG": "^CNXFMCG",
    "NIFTY_METAL": "^CNXMETAL",
    "NIFTY_REALTY": "^CNXREALTY",
    "NIFTY_PHARMA": "^CNXPHARMA",
    "NIFTY_PSU_BANK": "^CNXPSUBANK",
    "NIFTY_PRIVATE_BANK": "^CNXPVTBANK",
    "NIFTY_FIN_SERVICES": "^CNXFIN",
    "NIFTY_MEDIA": "^CNXMEDIA",
    "NIFTY_OIL_GAS": "^CNXENERGY",
    "NIFTY_CONSUMER_DURABLES": "^CNXCONSDUR",
    "NIFTY_CEMENT": "^CNXCEMENT",
    "NIFTY_CHEMICALS": "^CNXCHEMICALS",
    "NIFTY_FIN_SERVICES_25_50": "^CNXFIN2550",
    "NIFTY_FIN_SERVICES_EX_BANK": "^CNXFINEXBANK",
    "NIFTY_HEALTHCARE": "^CNXHEALTHCARE",
    "NIFTY_REITS_REALTY": "^CNXREITSREALTY",
    "NIFTY_500_HEALTHCARE": "^CNX500HLT",
    "NIFTY_MIDSMALL_FIN_SERVICES": "^CNXMSFIN",
    "NIFTY_MIDSMALL_HEALTHCARE": "^CNXMSHLT",
    "NIFTY_MIDSMALL_IT_TELECOM": "^CNXMSIT",
}

def get_engine():
    kwargs = {}
    if SYNC_DB_URL.startswith("sqlite"):
        kwargs["connect_args"] = {"timeout": 30}
    return create_engine(SYNC_DB_URL, pool_pre_ping=True, **kwargs)

def backfill_instruments(engine):
    with Session(engine) as session:
        # Get active instruments
        instruments = session.execute(
            text("SELECT id, symbol, segment FROM instruments WHERE is_active = 1")
        ).fetchall()
        
    logger.info(f"Loaded {len(instruments)} active instruments from database.")
    
    # Separate stocks and indices
    stocks = []
    indices = []
    
    for row in instruments:
        iid, sym, segment = row
        if segment == "EQ":
            stocks.append((iid, sym))
        elif segment == "IND":
            indices.append((iid, sym))
            
    logger.info(f"Active stocks: {len(stocks)}, Active indices: {len(indices)}")
    
    # ─── 1. BACKFILL STOCKS ───
    chunk_size = 50
    total_records = 0
    
    for i in range(0, len(stocks), chunk_size):
        chunk = stocks[i : i + chunk_size]
        logger.info(f"Downloading stock chunk {i // chunk_size + 1}...")
        
        tickers_map = {f"{sym}.NS": iid for iid, sym in chunk}
        tickers_list = list(tickers_map.keys())
        
        try:
            df = yf.download(
                tickers_list,
                period="max",
                interval="1d",
                group_by="ticker",
                auto_adjust=True,
                progress=False
            )
            
            with Session(engine) as session:
                for ticker in tickers_list:
                    if isinstance(df.columns, pd.MultiIndex):
                        if ticker not in df.columns.levels[0]:
                            continue
                        ticker_df = df[ticker].dropna(subset=["Open", "High", "Low", "Close"]).copy()
                    else:
                        ticker_df = df.dropna(subset=["Open", "High", "Low", "Close"]).copy()
                    
                    if ticker_df.empty:
                        continue
                        
                    iid = tickers_map[ticker]
                    records = []
                    for dt, row_data in ticker_df.iterrows():
                        records.append({
                            "time": dt.date(),
                            "iid": iid,
                            "o": float(row_data["Open"]),
                            "h": float(row_data["High"]),
                            "l": float(row_data["Low"]),
                            "c": float(row_data["Close"]),
                            "v": int(row_data["Volume"]) if pd.notnull(row_data["Volume"]) else 0,
                        })
                    if records:
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
                        total_records += len(records)
                session.commit()
                logger.info(f"Stock Chunk {i // chunk_size + 1} committed. Total records: {total_records}")
        except Exception as e:
            logger.error(f"Stock Chunk error: {e}. Downloading stocks individually...")
            # Individual fallback
            for iid, sym in chunk:
                ticker = f"{sym}.NS"
                try:
                    df_ind = yf.download(ticker, period="max", interval="1d", auto_adjust=True, progress=False)
                    if isinstance(df_ind.columns, pd.MultiIndex):
                        df_ind.columns = df_ind.columns.droplevel(1)
                    df_ind = df_ind.dropna(subset=["Open", "High", "Low", "Close"]).copy()
                    if df_ind.empty:
                        continue
                    records = []
                    for dt, row_data in df_ind.iterrows():
                        records.append({
                            "time": dt.date(),
                            "iid": iid,
                            "o": float(row_data["Open"]),
                            "h": float(row_data["High"]),
                            "l": float(row_data["Low"]),
                            "c": float(row_data["Close"]),
                            "v": int(row_data["Volume"]) if pd.notnull(row_data["Volume"]) else 0,
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
                        total_records += len(records)
                except Exception as ex:
                    logger.error(f"Failed individual download for {ticker}: {ex}")
                time.sleep(0.5)

    # ─── 2. BACKFILL INDICES ───
    logger.info("Starting backfill for indices from commencement...")
    for iid, sym in indices:
        yticker = INDEX_TICKERS.get(sym)
        if not yticker:
            logger.warning(f"No Yahoo Finance ticker mapped for index {sym}. Skipping.")
            continue
            
        logger.info(f"Downloading index {sym} via Yahoo ticker {yticker}...")
        try:
            df_ind = yf.download(yticker, period="max", interval="1d", auto_adjust=True, progress=False)
            if df_ind.empty:
                logger.warning(f"No data returned for index ticker {yticker}")
                continue
                
            if isinstance(df_ind.columns, pd.MultiIndex):
                df_ind.columns = df_ind.columns.droplevel(1)
            df_ind = df_ind.dropna(subset=["Open", "High", "Low", "Close"]).copy()
            logger.info(f"Index {sym}: downloaded {len(df_ind)} bars since inception.")
            
            records = []
            for dt, row_data in df_ind.iterrows():
                records.append({
                    "time": dt.date(),
                    "iid": iid,
                    "o": float(row_data["Open"]),
                    "h": float(row_data["High"]),
                    "l": float(row_data["Low"]),
                    "c": float(row_data["Close"]),
                    "v": int(row_data["Volume"]) if pd.notnull(row_data["Volume"]) else 0,
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
                total_records += len(records)
                logger.info(f"Index {sym} backfilled successfully.")
        except Exception as ex:
            logger.error(f"Failed to download index {sym} ({yticker}): {ex}")
        time.sleep(0.5)

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

    logger.info(f"✅ Backfill finished! Ingested/Updated a total of {total_records} OHLCV records.")

def run_scans():
    logger.info("Triggering pattern and trendline scans to process new history...")
    venv_python = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "venv", "bin", "python")
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
    subprocess.run([venv_python, "-c", scan_script], env=env)
    logger.info("Scans complete.")

def main():
    engine = get_engine()
    backfill_instruments(engine)
    run_scans()

if __name__ == "__main__":
    main()
