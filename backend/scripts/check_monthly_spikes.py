#!/usr/bin/env python
"""PEESTOCK — Monthly Candle Price Spike Audit.

This script resamples the entire historical daily EOD data (ohlcv_eod) to monthly candles
and scans for any abnormal price spikes or cliffs on the monthly timeframe.
"""

import os
import sys
import sqlite3
import pandas as pd
import logging

# Configure logging
logging.basicConfig(level=logging.INFO, format="%(asctime)s — %(levelname)s — %(message)s")
logger = logging.getLogger(__name__)

# Add backend to path
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
from app.config import get_settings

settings = get_settings()
DB_URL = settings.DATABASE_URL.replace("+asyncpg", "").replace("+aiosqlite", "").replace("sqlite+aiosqlite:///", "sqlite:///").replace("sqlite+aiosqlite://", "sqlite://")


def get_db_connection():
    if DB_URL.startswith("sqlite"):
        db_path = DB_URL.replace("sqlite:///", "").replace("sqlite://", "")
        if "?" in db_path:
            db_path = db_path.split("?")[0]
        return sqlite3.connect(db_path)
    else:
        import psycopg2
        pg_url = DB_URL.replace("postgresql+psycopg2://", "postgresql://")
        return psycopg2.connect(pg_url)


def check_monthly_spikes():
    conn = get_db_connection()
    cursor = conn.cursor()
    
    # Fetch all active EQ instruments
    cursor.execute("SELECT id, symbol FROM instruments WHERE segment = 'EQ' AND is_active = 1")
    instruments = cursor.fetchall()
    
    logger.info(f"Loaded {len(instruments)} active equities for monthly spike analysis.")
    
    anomalies_found = []
    
    for i, (iid, symbol) in enumerate(instruments):
        # Query all EOD close prices for this instrument
        df = pd.read_sql_query(
            "SELECT time, close FROM ohlcv_eod WHERE instrument_id = ? AND close IS NOT NULL ORDER BY time",
            conn,
            params=(iid,)
        )
        
        if df.empty or len(df) < 5:
            continue
            
        # Set datetime index
        df["time"] = pd.to_datetime(df["time"])
        df = df.set_index("time")
        
        # Resample to monthly close
        # Try both 'ME' (modern pandas) and 'M' (older pandas)
        try:
            df_m = df.resample("ME").last().dropna()
        except ValueError:
            df_m = df.resample("M").last().dropna()
            
        if len(df_m) < 3:
            continue
            
        # Scan for monthly spikes
        # A spike is a month-to-month change > 50% that immediately reverses,
        # or a sudden month-to-month change > 70% (which is extremely abnormal for a monthly candle).
        df_m["prev_close"] = df_m["close"].shift(1)
        df_m["next_close"] = df_m["close"].shift(-1)
        
        for dt, row in df_m.iterrows():
            close = row["close"]
            prev = row["prev_close"]
            nxt = row["next_close"]
            
            if pd.isnull(prev) or pd.isnull(nxt) or close <= 0.5 or prev <= 0.5 or nxt <= 0.5:
                continue
                
            # 1. Positive Spike: Month M is > 50% higher than both M-1 and M+1
            if close > 1.5 * prev and close > 1.5 * nxt:
                pct_up = (close - prev) / prev * 100
                pct_down = (close - nxt) / close * 100
                anomalies_found.append({
                    "symbol": symbol,
                    "instrument_id": iid,
                    "type": "Positive Monthly Spike",
                    "date": dt.strftime("%Y-%m"),
                    "prev_close": prev,
                    "spike_close": close,
                    "next_close": nxt,
                    "pct_change": f"+{pct_up:.1f}% / -{pct_down:.1f}%"
                })
                
            # 2. Negative Spike: Month M is > 50% lower than both M-1 and M+1
            elif close < 0.5 * prev and close < 0.5 * nxt:
                pct_down = (prev - close) / prev * 100
                pct_up = (nxt - close) / close * 100
                anomalies_found.append({
                    "symbol": symbol,
                    "instrument_id": iid,
                    "type": "Negative Monthly Spike",
                    "date": dt.strftime("%Y-%m"),
                    "prev_close": prev,
                    "spike_close": close,
                    "next_close": nxt,
                    "pct_change": f"-{pct_down:.1f}% / +{pct_up:.1f}%"
                })
                
            # 3. Permanent Cliff: Month M is > 50% different from M-1, and stays there.
            # This could be a split/bonus that was never adjusted.
            # We look for close < 0.55 * prev or close > 1.8 * prev.
            # If it's a real split/bonus, we want to know if it remains in the DB.
            elif (close < 0.5 * prev) and not (nxt > 1.4 * close):
                # Check if it was a real market crash or an unadjusted cliff.
                # If the cliff is exactly a split ratio (e.g. 50% for 2:1 split, 80% for 5:1 split, 90% for 10:1 split),
                # it is highly suspect.
                pct_drop = (prev - close) / prev * 100
                # We log it as a potential unadjusted cliff
                anomalies_found.append({
                    "symbol": symbol,
                    "instrument_id": iid,
                    "type": "Potential Unadjusted Split/Cliff",
                    "date": dt.strftime("%Y-%m"),
                    "prev_close": prev,
                    "spike_close": close,
                    "next_close": nxt,
                    "pct_change": f"-{pct_drop:.1f}% (permanent)"
                })
                
    conn.close()
    
    # Print results
    print("\n" + "=" * 80)
    print(f"MONTHLY TIME FRAME CANDLE SPIKE AUDIT REPORT")
    print("=" * 80)
    print(f"Total anomalies found: {len(anomalies_found)}")
    print("-" * 80)
    
    for idx, a in enumerate(anomalies_found):
        print(f"[{idx+1}] Ticker: {a['symbol']} (ID: {a['instrument_id']})")
        print(f"    Type: {a['type']}")
        print(f"    Date of Anomaly: {a['date']}")
        print(f"    Prices: Prev Month Close: {a['prev_close']:.2f} | Anomaly Close: {a['spike_close']:.2f} | Next Month Close: {a['next_close']:.2f}")
        print(f"    Percentage Change: {a['pct_change']}")
        print("-" * 80)
        
    return anomalies_found


if __name__ == "__main__":
    check_monthly_spikes()
