import pandas as pd
import json
from app.services.scanner_engine import evaluate_condition, run_scanner
from datetime import datetime, timedelta

# Create synthetic OHLCV data for 100 days
dates = pd.date_range(end=datetime.now(), periods=100)
df = pd.DataFrame({
    'time': dates,
    'open': [100 + i for i in range(100)],
    'high': [102 + i for i in range(100)],
    'low': [98 + i for i in range(100)],
    'close': [101 + i for i in range(100)],
    'volume': [1000 + i*10 for i in range(100)]
})

scans = [
    ('[{"indicator": "sma", "params": {"period": 50}, "operator": "crosses_above", "compare_to": {"indicator": "sma", "params": {"period": 200}}}]'),
    ('[{"indicator": "sma", "params": {"period": 50}, "operator": "crosses_below", "compare_to": {"indicator": "sma", "params": {"period": 200}}}]'),
    ('[{"indicator": "rsi", "params": {"period": 14}, "operator": "lt", "value": 30}]'),
    ('[{"indicator": "rsi", "params": {"period": 14}, "operator": "gt", "value": 70}]'),
    ('[{"indicator": "macd", "params": {"fast": 12, "slow": 26, "signal": 9, "component": "macd"}, "operator": "crosses_above", "compare_to": {"indicator": "macd", "params": {"fast": 12, "slow": 26, "signal": 9, "component": "signal"}}}]'),
    ('[{"indicator": "bbands", "params": {"period": 20, "std_dev": 2.0, "component": "bandwidth"}, "operator": "lt", "value": 0.05}]'),
    ('[{"indicator": "supertrend", "params": {"period": 10, "multiplier": 3.0, "component": "trend"}, "operator": "eq", "value": 1}]'),
    ('[{"indicator": "adx", "params": {"period": 14, "component": "adx"}, "operator": "gt", "value": 25}]'),
    ('[{"indicator": "nr7", "params": {}, "operator": "eq", "value": 1}]'),
    ('[{"indicator": "inside_bar", "params": {}, "operator": "eq", "value": 1}]'),
    ('[{"indicator": "engulfing", "params": {}, "operator": "eq", "value": 1}]'),
    ('[{"indicator": "hammer", "params": {}, "operator": "eq", "value": 1}]'),
    ('[{"indicator": "gap_up", "params": {"min_percent": 1.0}, "operator": "eq", "value": 1}]')
]

for idx, cond_str in enumerate(scans):
    conds = json.loads(cond_str)
    try:
        res = run_scanner(df, conds)
        print(f"Scan {idx+1} OK! Result: {res}")
    except Exception as e:
        print(f"Scan {idx+1} FAILED! Error: {e}")
