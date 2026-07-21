#!/usr/bin/env python
"""PEESTOCK — Multi-Timeframe Bullish Candle Scanner.

This script scans the SQLite database for active stocks that are showing
bullish candles (Close > Open) on all three timeframes simultaneously:
1. Daily Timeframe (current day's candle)
2. Weekly Timeframe (current week's resampled candle)
3. Monthly Timeframe (current month's resampled candle)

This is a powerful momentum-alignment filter used by professional traders.
"""

import os
import sys
import sqlite3
import pandas as pd
import logging
from datetime import datetime

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


def scan_multi_timeframe_bullish():
    conn = get_db_connection()
    cursor = conn.cursor()
    
    # Fetch all active EQ instruments
    cursor.execute("SELECT id, symbol, name FROM instruments WHERE segment = 'EQ' AND is_active = 1")
    instruments = cursor.fetchall()
    
    logger.info(f"Scanning {len(instruments)} active equities for Daily + Weekly + Monthly Bullish Alignment...")
    
    matches = []
    
    for i, (iid, symbol, name) in enumerate(instruments):
        # Query EOD history (we need at least 60 trading days to resample weekly/monthly)
        df = pd.read_sql_query(
            "SELECT time, open, high, low, close, volume FROM ohlcv_eod WHERE instrument_id = ? AND close IS NOT NULL ORDER BY time",
            conn,
            params=(iid,)
        )
        
        if df.empty or len(df) < 40:
            continue
            
        # Set datetime index
        df["time"] = pd.to_datetime(df["time"])
        df = df.set_index("time")
        
        try:
            # 1. Daily Candle
            d_candle = df.iloc[-1]
            d_open = float(d_candle["open"])
            d_close = float(d_candle["close"])
            d_high = float(d_candle["high"])
            d_low = float(d_candle["low"])
            d_vol = int(d_candle["volume"])
            
            # Check if Daily is Bullish
            if d_close <= d_open:
                continue
                
            # 2. Weekly Candle (Resample Daily EOD to Weekly)
            try:
                df_w = df.resample("W-FRI").agg({
                    "open": "first", "high": "max", "low": "min", "close": "last", "volume": "sum"
                }).dropna()
            except Exception:
                df_w = df.resample("W").agg({
                    "open": "first", "high": "max", "low": "min", "close": "last", "volume": "sum"
                }).dropna()
                
            if df_w.empty:
                continue
                
            w_candle = df_w.iloc[-1]
            w_open = float(w_candle["open"])
            w_close = float(w_candle["close"])
            
            # Check if Weekly is Bullish
            if w_close <= w_open:
                continue
                
            # 3. Monthly Candle (Resample Daily EOD to Monthly)
            try:
                df_m = df.resample("ME").agg({
                    "open": "first", "high": "max", "low": "min", "close": "last", "volume": "sum"
                }).dropna()
            except Exception:
                df_m = df.resample("M").agg({
                    "open": "first", "high": "max", "low": "min", "close": "last", "volume": "sum"
                }).dropna()
                
            if df_m.empty:
                continue
                
            m_candle = df_m.iloc[-1]
            m_open = float(m_candle["open"])
            m_close = float(m_candle["close"])
            
            # Check if Monthly is Bullish
            if m_close <= m_open:
                continue
                
            # Compute gains
            d_gain = (d_close - d_open) / d_open * 100
            w_gain = (w_close - w_open) / w_open * 100
            m_gain = (m_close - m_open) / m_open * 100
            
            matches.append({
                "symbol": symbol,
                "name": name,
                "close": d_close,
                "volume": d_vol,
                "d_gain": d_gain,
                "w_gain": w_gain,
                "m_gain": m_gain,
            })
            
        except Exception as e:
            # Skip any malformed histories
            continue
            
    conn.close()
    
    # Sort matches by monthly gain descending
    matches = sorted(matches, key=lambda x: x["m_gain"], reverse=True)
    
    # Print results
    print("\n" + "=" * 90)
    print(f"MULTI-TIMEFRAME BULLISH CANDLE SCREENER REPORT ({datetime.now().strftime('%Y-%m-%d %H:%M')})")
    print("Filters: Close > Open on Daily AND Weekly AND Monthly charts")
    print("=" * 90)
    print(f"Found {len(matches)} stocks matching the criteria.")
    print("-" * 90)
    
    # Format table header
    print(f"{'Ticker':<12} | {'Close':<10} | {'Volume':<12} | {'Daily Gain':<11} | {'Weekly Gain':<12} | {'Monthly Gain':<12}")
    print("-" * 90)
    
    for m in matches[:100]:  # Show top 100
        print(f"{m['symbol']:<12} | {m['close']:<10.2f} | {m['volume']:<12,} | {m['d_gain']:>+9.2f}% | {m['w_gain']:>+10.2f}% | {m['m_gain']:>+10.2f}%")
        
    print("=" * 90)
    print(f"Report generated successfully. Total matches: {len(matches)}.")
    print("=" * 90)
    
    return matches


if __name__ == "__main__":
    scan_multi_timeframe_bullish()
