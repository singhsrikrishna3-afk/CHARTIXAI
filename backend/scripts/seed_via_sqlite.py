import sqlite3
import json
import uuid
from datetime import datetime
import os
import sys

# Base directory of the project
BASE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
DB_PATH = os.path.join(BASE_DIR, "peestock.db")

SCANNERS = [
    {
        "name": "Golden Crossover (Long Term Bullish)",
        "description": "The 50-day Simple Moving Average crosses above the 200-day Simple Moving Average, indicating the start of a major long-term bullish trend.",
        "logic": "AND",
        "conditions": [
            {
                "indicator": "sma",
                "params": {"period": 50},
                "operator": "crosses_above",
                "compare_to": {
                    "indicator": "sma",
                    "params": {"period": 200}
                }
            }
        ]
    },
    {
        "name": "Death Crossover (Long Term Bearish)",
        "description": "The 50-day Simple Moving Average crosses below the 200-day Simple Moving Average, indicating the start of a major long-term bearish trend.",
        "logic": "AND",
        "conditions": [
            {
                "indicator": "sma",
                "params": {"period": 50},
                "operator": "crosses_below",
                "compare_to": {
                    "indicator": "sma",
                    "params": {"period": 200}
                }
            }
        ]
    },
    {
        "name": "RSI Oversold (Potential Reversal)",
        "description": "The Relative Strength Index (14) has dropped below 30, signaling an oversold condition and a potential bullish reversal.",
        "logic": "AND",
        "conditions": [
            {
                "indicator": "rsi",
                "params": {"period": 14},
                "operator": "lt",
                "value": 30
            }
        ]
    },
    {
        "name": "RSI Overbought (Potential Pullback)",
        "description": "The Relative Strength Index (14) has risen above 70, signaling an overbought condition and a potential bearish pullback.",
        "logic": "AND",
        "conditions": [
            {
                "indicator": "rsi",
                "params": {"period": 14},
                "operator": "gt",
                "value": 70
            }
        ]
    },
    {
        "name": "MACD Bullish Crossover",
        "description": "The MACD line has crossed above its Signal line, indicating an upward shift in momentum.",
        "logic": "AND",
        "conditions": [
            {
                "indicator": "macd",
                "params": {"fast": 12, "slow": 26, "signal": 9, "component": "macd"},
                "operator": "crosses_above",
                "compare_to": {
                    "indicator": "macd",
                    "params": {"fast": 12, "slow": 26, "signal": 9, "component": "signal"}
                }
            }
        ]
    },
    {
        "name": "Bollinger Band Squeeze Breakout",
        "description": "Bollinger Bands have tightened (Bandwidth < 0.05), indicating a period of extremely low volatility. A massive price breakout is imminent.",
        "logic": "AND",
        "conditions": [
            {
                "indicator": "bbands",
                "params": {"period": 20, "std_dev": 2.0, "component": "bandwidth"},
                "operator": "lt",
                "value": 0.05
            }
        ]
    },
    {
        "name": "Supertrend Buy Signal",
        "description": "Price has crossed above the Supertrend line, giving a fresh buy signal and indicating a newly formed uptrend.",
        "logic": "AND",
        "conditions": [
            {
                "indicator": "supertrend",
                "params": {"period": 10, "multiplier": 3.0, "component": "trend"},
                "operator": "eq",
                "value": 1
            }
        ]
    },
    {
        "name": "ADX Strong Trend Formation",
        "description": "The Average Directional Index (ADX 14) is greater than 25, confirming the presence of a strong underlying trend.",
        "logic": "AND",
        "conditions": [
            {
                "indicator": "adx",
                "params": {"period": 14, "component": "adx"},
                "operator": "gt",
                "value": 25
            }
        ]
    },
    {
        "name": "NR7 (Narrow Range 7)",
        "description": "The stock has formed its narrowest trading range of the last 7 days. Volatility contraction often precedes a strong explosive directional move.",
        "logic": "AND",
        "conditions": [
            {
                "indicator": "nr7",
                "params": {},
                "operator": "eq",
                "value": 1
            }
        ]
    },
    {
        "name": "Inside Bar Breakout Setup",
        "description": "The current daily candle is completely contained within the previous day's high-low range, indicating indecision before a major move.",
        "logic": "AND",
        "conditions": [
            {
                "indicator": "inside_bar",
                "params": {},
                "operator": "eq",
                "value": 1
            }
        ]
    },
    {
        "name": "Bullish Engulfing Pattern",
        "description": "A large bullish candle has completely engulfed the previous bearish candle's body, a very strong signal of bottoming and reversal.",
        "logic": "AND",
        "conditions": [
            {
                "indicator": "engulfing",
                "params": {},
                "operator": "eq",
                "value": 1
            }
        ]
    },
    {
        "name": "Hammer Candlestick",
        "description": "A hammer candlestick has formed with a long lower shadow and a small body, showing aggressive buying at the lows. Excellent reversal signal.",
        "logic": "AND",
        "conditions": [
            {
                "indicator": "hammer",
                "params": {},
                "operator": "eq",
                "value": 1
            }
        ]
    },
    {
        "name": "Strong Gap Up Open",
        "description": "The stock has gapped up by at least 1% compared to yesterday's high, indicating overwhelming buying pressure right from the market open.",
        "logic": "AND",
        "conditions": [
            {
                "indicator": "gap_up",
                "params": {"min_percent": 1.0},
                "operator": "eq",
                "value": 1
            }
        ]
    }
]

def seed_sqlite():
    print(f"🚀 Connecting directly to database: {DB_PATH}")
    # High timeout to wait out any existing locks gracefully
    conn = sqlite3.connect(DB_PATH, timeout=120.0)
    cursor = conn.cursor()
    
    cursor.execute("SELECT id FROM users LIMIT 1")
    user_row = cursor.fetchone()
    if not user_row:
        print("❌ No users found in database.")
        conn.close()
        return
        
    user_id = user_row[0]
    
    cursor.execute("SELECT name FROM custom_scanners")
    existing_names = {row[0] for row in cursor.fetchall()}
    
    added = 0
    for scan in SCANNERS:
        if scan["name"] in existing_names:
            print(f"⏩ Scanner already exists: {scan['name']}")
            continue
            
        scan_id = uuid.uuid4().hex
        now = datetime.utcnow().strftime('%Y-%m-%d %H:%M:%S.%f')
        
        cursor.execute('''
            INSERT INTO custom_scanners 
            (id, user_id, name, description, conditions, logic, is_public, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ''', (
            scan_id,
            user_id,
            scan["name"],
            scan["description"],
            json.dumps(scan["conditions"]),
            scan["logic"],
            1,
            now,
            now
        ))
        added += 1
        print(f"✅ Added: {scan['name']}")
        
    conn.commit()
    conn.close()
    print(f"\n🎉 Successfully added {added} new scanners via direct SQLite!")

if __name__ == "__main__":
    seed_sqlite()
