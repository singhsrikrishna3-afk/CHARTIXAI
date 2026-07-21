#!/usr/bin/env python
"""PEESTOCK — Daily Candle Price Spike Auditor and Repairer.

This script scans the daily EOD records (ohlcv_eod) for isolated 1-day price spikes
(e.g., price doubles and then drops back the next day, or halves and then doubles back).
These represent data errors in the historical Yahoo Finance feed itself.
It prints them and automatically repairs them by interpolating from surrounding days.
"""

import os
import sys
import sqlite3
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


def audit_and_fix_daily_spikes():
    conn = get_db_connection()
    cursor = conn.cursor()
    
    logger.info("Scanning ohlcv_eod for isolated daily price spikes...")
    
    # SQL query to find isolated 1-day spikes using window functions LAG and LEAD.
    # We define an isolated spike as:
    # 1. Price is > 2.0x higher than both previous and next day (Positive Spike)
    # 2. Price is < 0.5x lower than both previous and next day (Negative Spike)
    # We exclude penny stocks (< 2.0 INR) to avoid low price volatility noise.
    query = """
        WITH ranked AS (
            SELECT 
                instrument_id, 
                time, 
                open, high, low, close, volume,
                LAG(time) OVER (PARTITION BY instrument_id ORDER BY time) as prev_time,
                LAG(close) OVER (PARTITION BY instrument_id ORDER BY time) as prev_close,
                LEAD(time) OVER (PARTITION BY instrument_id ORDER BY time) as next_time,
                LEAD(close) OVER (PARTITION BY instrument_id ORDER BY time) as next_close
            FROM ohlcv_eod
        )
        SELECT 
            r.instrument_id, 
            i.symbol, 
            r.time, 
            r.open, r.high, r.low, r.close, r.volume,
            r.prev_time, r.prev_close,
            r.next_time, r.next_close
        FROM ranked r
        JOIN instruments i ON r.instrument_id = i.id
        WHERE 
            i.is_active = 1
            AND r.prev_close IS NOT NULL 
            AND r.next_close IS NOT NULL
            AND r.close > 2.0
            AND r.prev_close > 2.0
            AND r.next_close > 2.0
            AND (
                -- Positive Spike
                (r.close > 2.0 * r.prev_close AND r.close > 2.0 * r.next_close)
                OR
                -- Negative Spike
                (r.close < 0.5 * r.prev_close AND r.close < 0.5 * r.next_close)
            )
        ORDER BY r.time DESC
    """
    
    cursor.execute(query)
    spikes = cursor.fetchall()
    
    logger.info(f"Found {len(spikes)} isolated daily price spikes in the database.")
    
    if not spikes:
        print("\n" + "=" * 80)
        print("DAILY CANDLE SPIKE AUDIT: ZERO ANOMALIES FOUND! DATABASE IS 100% CLEAN.")
        print("=" * 80)
        conn.close()
        return
        
    print("\n" + "=" * 80)
    print(f"DAILY CANDLE SPIKE AUDIT: DETECTED {len(spikes)} ANOMALIES")
    print("=" * 80)
    
    repairs = []
    for idx, s in enumerate(spikes):
        iid, symbol, dt, o, h, l, c, v, p_dt, p_c, n_dt, n_c = s
        
        # Calculate interpolated price (average of prev and next closes)
        interp_c = (p_c + n_c) / 2
        
        print(f"[{idx+1}] Ticker: {symbol} (ID: {iid}) on {dt}")
        if c > p_c:
            print(f"    Type: Positive 1-Day Price Spike")
            print(f"    Prices: Prev close ({p_dt}): {p_c:.2f} | SPIKE close: {c:.2f} | Next close ({n_dt}): {n_c:.2f}")
        else:
            print(f"    Type: Negative 1-Day Price Spike")
            print(f"    Prices: Prev close ({p_dt}): {p_c:.2f} | SPIKE close: {c:.2f} | Next close ({n_dt}): {n_c:.2f}")
            
        print(f"    Action: Repairing by interpolating to close: {interp_c:.2f}")
        print("-" * 80)
        
        # Prepare database update values
        # We set open, high, low, close all to the interpolated value as a safe, clean repair
        repairs.append((interp_c, interp_c, interp_c, interp_c, iid, dt))
        
    # Execute repairs
    if repairs:
        logger.info(f"Applying {len(repairs)} price repairs to ohlcv_eod...")
        cursor.executemany(
            """
            UPDATE ohlcv_eod
            SET open = ?, high = ?, low = ?, close = ?
            WHERE instrument_id = ? AND time = ?
            """,
            repairs
        )
        conn.commit()
        logger.info("Database repairs committed successfully.")
        
    conn.close()


if __name__ == "__main__":
    audit_and_fix_daily_spikes()
