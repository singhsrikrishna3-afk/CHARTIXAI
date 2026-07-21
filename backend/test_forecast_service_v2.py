"""Test v2 feature engineering. Run directly: python test_forecast_service_v2.py"""
import numpy as np
import pandas as pd
from app.services.forecast_service import compute_feature_frame, FEATURE_NAMES

failures = []

def check(label, condition):
    if not condition:
        failures.append(label)
        print(f"FAIL: {label}")
    else:
        print(f"PASS: {label}")

# Build a fake 100-day OHLCV DataFrame with a mild uptrend
n = 100
rng = np.random.RandomState(0)
closes = 100 + np.cumsum(rng.randn(n) * 0.5 + 0.05)
highs = closes + np.abs(rng.randn(n) * 0.3)
lows = closes - np.abs(rng.randn(n) * 0.3)
volumes = rng.randint(100_000, 500_000, n).astype(float)
df = pd.DataFrame({"close": closes, "high": highs, "low": lows, "volume": volumes})

feat = compute_feature_frame(df)

check("feature frame has same length as input", len(feat) == n)
check("feature frame has all expected columns", list(feat.columns) == FEATURE_NAMES)
check("RSI values are within [0,100] where not NaN", feat["rsi"].dropna().between(0, 100).all())
check("bb_pctb is mostly within [-1, 2] (allows some overshoot, catches gross errors)",
      feat["bb_pctb"].dropna().between(-1, 2).all())
check("last row has no NaN (enough warmup history by day 100)", not feat.iloc[-1].isna().any())
check("first row IS NaN for indicators needing warmup (e.g. rsi)", pd.isna(feat["rsi"].iloc[0]))

from app.services.forecast_service import build_relative_sequences, LOOKBACK, HORIZON_V2

# Build two fake series: a stock that outperforms a flat-ish "NIFTY" benchmark
n = 150
rng2 = np.random.RandomState(1)
stock_closes = 100 + np.cumsum(rng2.randn(n) * 0.4 + 0.08)  # stock drifts up
nifty_closes = 100 + np.cumsum(rng2.randn(n) * 0.2 + 0.01)  # benchmark drifts up slower
stock_highs = stock_closes + np.abs(rng2.randn(n) * 0.3)
stock_lows = stock_closes - np.abs(rng2.randn(n) * 0.3)
stock_volumes = rng2.randint(100_000, 500_000, n).astype(float)

stock_df = pd.DataFrame({
    "close": stock_closes, "high": stock_highs, "low": stock_lows, "volume": stock_volumes,
})
nifty_close_series = pd.Series(nifty_closes)

X2, y2 = build_relative_sequences(stock_df, nifty_close_series)

min_required = LOOKBACK + HORIZON_V2 + 20  # +20 for feature warmup (SMA20/rolling20)
expected_min_samples = n - min_required + 1 if n >= min_required else 0

check("X2 has the feature dimension", X2.shape[2] == 6 if len(X2) > 0 else True)
check("X2 has LOOKBACK rows per window", X2.shape[1] == LOOKBACK if len(X2) > 0 else True)
check("y2 has HORIZON_V2 targets per sample", y2.shape[1] == HORIZON_V2 if len(y2) > 0 else True)
check("got at least one sample from 150 days of history", len(X2) > 0)
check("X2 has no NaN (warmup rows excluded)", not np.isnan(X2).any() if len(X2) > 0 else True)
check("y2 has no NaN", not np.isnan(y2).any() if len(y2) > 0 else True)

# Mismatched-length inputs should return empty arrays rather than crash
short_nifty = pd.Series(nifty_closes[:10])
X3, y3 = build_relative_sequences(stock_df, short_nifty)
check("mismatched/insufficient nifty history returns empty arrays", len(X3) == 0 and len(y3) == 0)

from app.services.forecast_service import calibrate_bands

# Residuals for 2 horizon days: day 1 tight, day 2 wider spread
rng3 = np.random.RandomState(2)
residuals = {
    1: rng3.randn(500) * 0.01,   # ~1% std
    2: rng3.randn(500) * 0.03,   # ~3% std
}
half_widths = calibrate_bands(residuals, coverage_target=0.90)

check("returns a half-width per horizon day", set(half_widths.keys()) == {1, 2})
check("day 2 half-width is wider than day 1 (matches larger residual spread)",
      half_widths[2] > half_widths[1])
check("half-widths are positive floats", all(v > 0 for v in half_widths.values()))

# Empty residuals for some horizon should not crash, just be excluded or zero
half_widths_empty = calibrate_bands({1: np.array([])}, coverage_target=0.90)
check("empty residual array doesn't crash (returns 0 or omits the key)",
      half_widths_empty.get(1, 0) == 0 or 1 not in half_widths_empty)

if failures:
    print(f"\n{len(failures)} check(s) failed: {failures}")
    raise SystemExit(1)
print("\nAll checks passed.")

# Regression fixture: pin exact current build_relative_sequences output on a
# fixed-seed synthetic series, so the upcoming vectorization can be checked
# against byte-for-byte identical results, not just shape/NaN checks.
import hashlib

def _fingerprint_sequences(X, y):
    """Stable hash of array contents, used to detect any numeric drift."""
    if len(X) == 0:
        return "empty"
    h = hashlib.sha256()
    h.update(np.round(X, decimals=5).tobytes())
    h.update(np.round(y, decimals=5).tobytes())
    return h.hexdigest()

rng4 = np.random.RandomState(42)
n4 = 200
stock_closes4 = 100 + np.cumsum(rng4.randn(n4) * 0.4 + 0.05)
nifty_closes4 = 100 + np.cumsum(rng4.randn(n4) * 0.2 + 0.01)
stock_highs4 = stock_closes4 + np.abs(rng4.randn(n4) * 0.3)
stock_lows4 = stock_closes4 - np.abs(rng4.randn(n4) * 0.3)
stock_volumes4 = rng4.randint(100_000, 500_000, n4).astype(float)

stock_df4 = pd.DataFrame({
    "close": stock_closes4, "high": stock_highs4, "low": stock_lows4, "volume": stock_volumes4,
})
nifty_close4 = pd.Series(nifty_closes4)

X4, y4 = build_relative_sequences(stock_df4, nifty_close4)
fingerprint = _fingerprint_sequences(X4, y4)
print(f"[fingerprint] current build_relative_sequences output: {fingerprint}")
print(f"[fingerprint] shapes: X={X4.shape}, y={y4.shape}")
