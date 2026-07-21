"""PEESTOCK — Seed 5-year resampled and 30-day 1m intraday data for all major symbols."""

import os
import sys
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
import sqlite3
from app.services.intraday_seeder import seed_intraday_on_demand
from app.config import get_settings

# Target symbols to seed with full historical intraday data
TARGET_SYMBOLS = [
    "NIFTY_50",
    "RELIANCE",
    "TCS",
    "INFY",
    "HDFCBANK",
    "ICICIBANK",
    "SBIN",
    "TATASTEEL",
    "AXISBANK",
    "ITC",
    "LT",
    "GOLD_MCX",
    "SILVER_MCX"
]

def main():
    # Resolve DB path from config settings
    settings = get_settings()
    db_url = settings.DATABASE_URL
    
    # Extract file path from sqlite:///path/to/db?options
    db_path = db_url.replace("sqlite:///", "").split("?")[0]
    if not os.path.isabs(db_path):
        from app.config import BASE_DIR
        db_path = os.path.abspath(os.path.join(BASE_DIR, db_path))

    print(f"🚀 Connecting to active DB at: {db_path}")
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()

    for symbol in TARGET_SYMBOLS:
        print(f"\nProcessing {symbol}...")
        
        # 1. Check if instrument exists
        cursor.execute("SELECT id FROM instruments WHERE symbol=?;", (symbol,))
        row = cursor.fetchone()
        if not row:
            # If it's a known index/commodity, create it
            segment = "IND" if symbol == "NIFTY_50" else ("COM" if "MCX" in symbol else "EQ")
            name = symbol.replace("_", " ")
            cursor.execute("""
                INSERT INTO instruments (symbol, name, segment, is_active, is_intraday, created_at, updated_at)
                VALUES (?, ?, ?, 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
            """, (symbol, name, segment))
            conn.commit()
            instrument_id = cursor.lastrowid
            print(f"Created new instrument {symbol} with ID: {instrument_id}")
        else:
            instrument_id = row[0]
            # Flag it as an active intraday instrument
            cursor.execute("UPDATE instruments SET is_intraday=1, is_active=1 WHERE id=?;", (instrument_id,))
            conn.commit()
            print(f"Found active instrument {symbol} with ID: {instrument_id}")

        # 2. Run the optimized on-demand seeder with force=True
        print(f"Running 5-year historical intraday seeder for {symbol}...")
        seed_intraday_on_demand(instrument_id, force=True)
        print(f"Completed seeding for {symbol}!")

    conn.close()
    print("\n🎉 Seeding completed successfully! All major symbols now have active 5-year historical intraday datasets.")

if __name__ == "__main__":
    main()
