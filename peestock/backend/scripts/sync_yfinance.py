"""PEESTOCK — Yahoo Finance Sync Script.

Downloads adjusted historical data to fill gaps and adjust for splits/dividends.
"""

import os
import sys
import logging
from datetime import date
import pandas as pd
import yfinance as yf
from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session

# Add backend to path
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from app.config import get_settings

logging.basicConfig(level=logging.INFO, format="%(asctime)s — %(message)s")
logger = logging.getLogger(__name__)

settings = get_settings()

SYNC_DB_URL = settings.DATABASE_URL.replace("+asyncpg", "").replace(
    "+aiosqlite", ""
).replace("postgresql+psycopg2", "postgresql")


def sync_yfinance(period="5y"):
    kwargs = {}
    if SYNC_DB_URL.startswith("sqlite"):
        kwargs["connect_args"] = {"timeout": 30}
    engine = create_engine(SYNC_DB_URL, pool_pre_ping=True, **kwargs)
    
    with Session(engine) as session:
        instruments = session.execute(
            text("SELECT id, symbol FROM instruments WHERE is_active = 1")
        ).fetchall()
        
        if not instruments:
            logger.error("No active instruments found.")
            return

        # Create mapping of symbol -> id
        sym_to_id = {sym: iid for iid, sym in instruments}
        # yfinance expects ".NS" for NSE
        tickers_list = [f"{sym}.NS" for sym in sym_to_id.keys()]
        
        logger.info(f"Downloading {period} data for {len(tickers_list)} tickers from yfinance...")
        
        # Download in chunks of 500 to avoid yfinance URI too long errors
        chunk_size = 500
        all_data = []
        
        for i in range(0, len(tickers_list), chunk_size):
            chunk = tickers_list[i:i + chunk_size]
            logger.info(f"Downloading chunk {i//chunk_size + 1}...")
            # We use group_by="ticker" to get multi-level columns
            df = yf.download(chunk, period=period, interval="1d", group_by="ticker", auto_adjust=True, threads=True)
            all_data.append(df)
            
        logger.info("Download complete. Ingesting into database...")
        
        total_upserts = 0
        
        for i, df in enumerate(all_data):
            chunk_tickers = tickers_list[i * chunk_size : (i + 1) * chunk_size]
            
            # If only 1 ticker was in the chunk, the columns are not multi-level
            if len(chunk_tickers) == 1:
                ticker = chunk_tickers[0]
                sym = ticker.replace(".NS", "")
                iid = sym_to_id[sym]
                
                ticker_df = df.dropna(subset=["Open", "High", "Low", "Close"]).copy()
                if ticker_df.empty:
                    continue
                    
                records = []
                for dt, row in ticker_df.iterrows():
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
                    total_upserts += len(records)
                continue
                
            # For multiple tickers, the columns are multi-level (Ticker, PriceType)
            for ticker in chunk_tickers:
                if ticker not in df.columns.levels[0]:
                    continue
                    
                sym = ticker.replace(".NS", "")
                iid = sym_to_id[sym]
                
                ticker_df = df[ticker].dropna(subset=["Open", "High", "Low", "Close"]).copy()
                if ticker_df.empty:
                    continue
                
                records = []
                for dt, row in ticker_df.iterrows():
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
                    total_upserts += len(records)
                    
            session.commit()
            logger.info(f"Chunk {i//chunk_size + 1} committed. Total records so far: {total_upserts}")

    logger.info(f"✅ Sync complete! Inserted/Updated {total_upserts} adjusted records.")

if __name__ == "__main__":
    period = sys.argv[1] if len(sys.argv) > 1 else "5y"
    sync_yfinance(period)
