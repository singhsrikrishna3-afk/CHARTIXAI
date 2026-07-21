import os
import requests
import json
import secrets
import sys

BASE_URL = "http://localhost:8000/api"

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

def seed_via_api():
    print("🚀 Connecting to local PEESTOCKS API...")

    admin_password = os.environ.get("PEESTOCKS_ADMIN_PASSWORD")
    generated = admin_password is None
    if generated:
        admin_password = secrets.token_urlsafe(16)

    creds = {
        "email": os.environ.get("PEESTOCKS_ADMIN_EMAIL", "admin@peestocks.com"),
        "password": admin_password,
        "full_name": "Admin User",
        "phone": "1234567890"
    }

    if generated:
        print(f"🔑 Generated admin password (save this, it won't be shown again): {admin_password}")

    token = None
    
    # Attempt Registration
    try:
        r = requests.post(f"{BASE_URL}/auth/register", json=creds)
        if r.status_code == 201:
            token = r.json()["access_token"]
            print("✅ Registered new system admin user.")
        elif r.status_code == 409:
            # Login if user exists
            r2 = requests.post(f"{BASE_URL}/auth/login", json={"email": creds["email"], "password": creds["password"]})
            if r2.status_code == 200:
                token = r2.json()["access_token"]
                print("✅ Logged in as existing system admin.")
            else:
                print(f"❌ Failed to login: {r2.text}")
                return
        else:
            print(f"❌ Failed to register: {r.text}")
            return
    except requests.exceptions.ConnectionError:
        print("❌ Cannot connect to backend server. Make sure it is running at http://localhost:8000")
        return
        
    headers = {"Authorization": f"Bearer {token}"}
    
    # Get existing scanners to avoid duplicates
    print("🔍 Fetching existing scanners...")
    r_exist = requests.get(f"{BASE_URL}/scanners", headers=headers)
    existing_names = set()
    if r_exist.status_code == 200:
        existing_names = {s["name"] for s in r_exist.json()}
        
    added = 0
    for scan in SCANNERS:
        if scan["name"] in existing_names:
            print(f"⏩ Scanner already exists: {scan['name']}")
            continue
            
        # Append is_public flag so all users can see it
        scan["is_public"] = True
        
        r_add = requests.post(f"{BASE_URL}/scanners", json=scan, headers=headers)
        if r_add.status_code == 201:
            print(f"✅ Added: {scan['name']}")
            added += 1
        else:
            print(f"❌ Failed to add {scan['name']}: {r_add.text}")
            
    print(f"\n🎉 Successfully added {added} new scanners via API!")

if __name__ == "__main__":
    seed_via_api()
