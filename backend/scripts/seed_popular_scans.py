import asyncio
import os
import sys

# Add the backend directory to Python path
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sqlalchemy import select
from app.database import get_db, Base, engine
from app.models import User, CustomScanner

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

async def seed_scanners():
    async for db in get_db():
        # Find an admin/default user to own the public scanners
        user_result = await db.execute(select(User).limit(1))
        user = user_result.scalar_one_or_none()
        
        if not user:
            print("❌ No users found in the database. Please create a user first before seeding scanners.")
            return

        print(f"✅ Seeding scanners under User ID: {user.id} ({user.email})")

        # Query all existing names upfront to prevent SQLite autoflush locking
        existing_names = (await db.execute(select(CustomScanner.name))).scalars().all()
        existing_set = set(existing_names)

        added_count = 0
        for scan_data in SCANNERS:
            # Check if this scanner name already exists to prevent duplicates
            if scan_data["name"] in existing_set:
                print(f"⏩ Scanner already exists: {scan_data['name']}")
                continue
                
            scanner = CustomScanner(
                user_id=user.id,
                name=scan_data["name"],
                description=scan_data["description"],
                conditions=scan_data["conditions"],
                logic=scan_data["logic"],
                is_public=True  # Important: Make these accessible to everyone
            )
            db.add(scanner)
            added_count += 1
            print(f"✅ Inserted: {scan_data['name']}")

        await db.commit()
        print(f"\n🎉 Successfully added {added_count} new public stock scanners to the database!")
        break # get_db is a generator, break after first yield

if __name__ == "__main__":
    asyncio.run(seed_scanners())
