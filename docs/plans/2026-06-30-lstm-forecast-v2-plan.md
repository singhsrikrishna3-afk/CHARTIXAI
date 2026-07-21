# LSTM Forecast Redesign v2 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the v1 LSTM forecast model (price/volume only, failed its honest backtest) with a v2 model using real technical-indicator features and NIFTY-relative return targets, validated against the same honest train/holdout backtest methodology before any decision to deploy it live.

**Architecture:** New functions added alongside the existing v1 code (not replacing it — v1 stays live and untouched in the running app while v2 is built and validated). v2 computes a 6-feature vector per day (RSI, MACD histogram, SMA distance, Bollinger %B, relative volume, daily return) via existing `scanner_engine.py` functions, predicts 5-day NIFTY-relative excess returns instead of absolute price, and replaces MC-dropout bands with empirically calibrated ones from a held-out calibration slice. A new backtest script reuses v1's train/holdout/naive-baseline methodology, adapted to correctly un-transform relative-return predictions back into comparable absolute-price MAPE.

**Tech Stack:** Same as v1 — PyTorch, pandas (via `scanner_engine.py`), SQLAlchemy sync session pattern from `tasks_eod.py`.

**Explicitly out of scope for this plan:** wiring v2 into the live `/api/forecasts/{symbol}` endpoint, chart overlay, or AI Assistant. Those currently serve v1. This plan only builds and validates v2 via its own backtest script — deploying it live is a separate follow-up decision made *after* seeing real backtest numbers, not assumed up front.

---

### Task 1: Feature engineering — `compute_feature_frame`

**Files:**
- Modify: `backend/app/services/forecast_service.py`
- Test: `backend/test_forecast_service_v2.py`

**Step 1: Write the failing test**

```python
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

if failures:
    print(f"\n{len(failures)} check(s) failed: {failures}")
    raise SystemExit(1)
print("\nAll checks passed.")
```

**Step 2: Run test to verify it fails**

Run: `cd "/Users/srikrishnasingh/AG1 BB/PEESTOCKS/backend" && source venv/bin/activate && PYTHONPATH=. python test_forecast_service_v2.py`
Expected: `ImportError: cannot import name 'compute_feature_frame'`

**Step 3: Write minimal implementation**

Add to `backend/app/services/forecast_service.py` (append, do not remove existing v1 `build_sequences`/`LOOKBACK`/`HORIZON` — v1 stays intact):

```python
import pandas as pd
from app.services.scanner_engine import compute_rsi, compute_macd, compute_sma, compute_bbands

FEATURE_NAMES = ["rsi", "macd_hist", "sma_dist", "bb_pctb", "rel_volume", "daily_return"]
N_FEATURES = len(FEATURE_NAMES)
HORIZON_V2 = 5
CALIBRATION_DAYS = 40  # bars held out from training, used only to calibrate band width


def compute_feature_frame(df: pd.DataFrame) -> pd.DataFrame:
    """df must have columns: close, high, low, volume, ascending by date (any index).
    Returns a DataFrame with FEATURE_NAMES columns, same length/index as df.
    Early rows are NaN where indicators need warmup history (e.g. RSI(14), SMA(20)).
    """
    close = df["close"]
    volume = df["volume"]

    rsi = compute_rsi(close, 14)
    macd_hist = compute_macd(close)["histogram"]

    sma20 = compute_sma(close, 20)
    sma_dist = (close - sma20) / sma20 * 100

    bb = compute_bbands(close, 20, 2.0)
    bb_range = (bb["upper"] - bb["lower"]).replace(0, np.nan)
    bb_pctb = (close - bb["lower"]) / bb_range

    vol_avg20 = volume.rolling(20).mean()
    rel_volume = volume / vol_avg20.replace(0, np.nan)

    daily_return = close.pct_change() * 100

    return pd.DataFrame({
        "rsi": rsi,
        "macd_hist": macd_hist,
        "sma_dist": sma_dist,
        "bb_pctb": bb_pctb,
        "rel_volume": rel_volume,
        "daily_return": daily_return,
    })
```

Also add `import numpy as np` if not already present at the top (it already is, from v1 code).

**Step 4: Run test to verify it passes**

Run: `cd "/Users/srikrishnasingh/AG1 BB/PEESTOCKS/backend" && source venv/bin/activate && PYTHONPATH=. python test_forecast_service_v2.py`
Expected: `All checks passed.`

---

### Task 2: Relative-return sequence building — `build_relative_sequences`

**Files:**
- Modify: `backend/app/services/forecast_service.py`
- Test: `backend/test_forecast_service_v2.py` (extend the same file from Task 1)

**Step 1: Write the failing test (append to the same test file)**

```python
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

if failures:
    print(f"\n{len(failures)} check(s) failed: {failures}")
    raise SystemExit(1)
print("\nAll checks passed.")
```

**Step 2: Run test to verify it fails**

Run: `cd "/Users/srikrishnasingh/AG1 BB/PEESTOCKS/backend" && source venv/bin/activate && PYTHONPATH=. python test_forecast_service_v2.py`
Expected: `ImportError: cannot import name 'build_relative_sequences'`

**Step 3: Write minimal implementation**

Add to `backend/app/services/forecast_service.py`:

```python
def build_relative_sequences(stock_df: pd.DataFrame, nifty_close: pd.Series):
    """Build (X, y) for the v2 model.

    stock_df: DataFrame with columns close, high, low, volume, ascending by date,
              index aligned 1:1 by position with nifty_close (both must be the
              same length and date-aligned by the caller — this function does NOT
              do a date join, callers must pre-align via a pandas merge on date).
    nifty_close: Series of NIFTY_50 close prices, same length/order as stock_df.

    Returns (X, y):
      X: (n_samples, LOOKBACK, N_FEATURES) float32, each window z-score normalized
         using that window's own per-feature mean/std (handles regime changes
         better than a single global normalization).
      y: (n_samples, HORIZON_V2) float32, target[i, h] = the stock's cumulative
         return over the next h+1 days MINUS NIFTY's cumulative return over the
         same days (i.e. predicted "alpha", as a fraction e.g. 0.01 = 1%).

    Returns empty arrays if there isn't enough aligned history for one sample,
    or if stock_df and nifty_close lengths don't match.
    """
    if len(stock_df) != len(nifty_close):
        return np.empty((0, LOOKBACK, N_FEATURES)), np.empty((0, HORIZON_V2))

    feat = compute_feature_frame(stock_df)
    valid_start = feat.first_valid_index() if not feat.isna().all().all() else None
    # First index where ALL feature columns are non-NaN
    first_complete = feat.dropna().index.min() if not feat.dropna().empty else None
    if first_complete is None:
        return np.empty((0, LOOKBACK, N_FEATURES)), np.empty((0, HORIZON_V2))

    feat_arr = feat.to_numpy(dtype=np.float64)
    stock_close_arr = stock_df["close"].to_numpy(dtype=np.float64)
    nifty_close_arr = nifty_close.to_numpy(dtype=np.float64)

    n = len(feat_arr)
    warmup = int(first_complete) if isinstance(first_complete, (int, np.integer)) else feat.index.get_loc(first_complete)
    usable_n = n - warmup
    min_required = LOOKBACK + HORIZON_V2
    if usable_n < min_required:
        return np.empty((0, LOOKBACK, N_FEATURES)), np.empty((0, HORIZON_V2))

    feat_usable = feat_arr[warmup:]
    stock_close_usable = stock_close_arr[warmup:]
    nifty_close_usable = nifty_close_arr[warmup:]

    n_samples = usable_n - min_required + 1
    X = np.zeros((n_samples, LOOKBACK, N_FEATURES), dtype=np.float32)
    y = np.zeros((n_samples, HORIZON_V2), dtype=np.float32)

    for i in range(n_samples):
        window = feat_usable[i:i + LOOKBACK]  # (LOOKBACK, N_FEATURES)
        mean = window.mean(axis=0)
        std = window.std(axis=0)
        std = np.where(std > 1e-8, std, 1.0)
        X[i] = (window - mean) / std

        anchor_idx = i + LOOKBACK - 1
        stock_anchor = stock_close_usable[anchor_idx]
        nifty_anchor = nifty_close_usable[anchor_idx]

        for h in range(HORIZON_V2):
            future_idx = anchor_idx + 1 + h
            stock_ret = (stock_close_usable[future_idx] - stock_anchor) / stock_anchor
            nifty_ret = (nifty_close_usable[future_idx] - nifty_anchor) / nifty_anchor
            y[i, h] = stock_ret - nifty_ret

    return X, y
```

**Step 4: Run test to verify it passes**

Run: `cd "/Users/srikrishnasingh/AG1 BB/PEESTOCKS/backend" && source venv/bin/activate && PYTHONPATH=. python test_forecast_service_v2.py`
Expected: `All checks passed.`

Note: this implementation uses a Python loop over samples (not vectorized like v1's `sliding_window_view` approach) because per-window z-score normalization with `.std(axis=0)` per window is harder to vectorize cleanly and n_samples here will be smaller (≤ a few hundred per instrument vs. v1's full history) since each instrument only contributes one slice. If this proves too slow in Task 5's real run (200 instruments), revisit with `sliding_window_view` + vectorized window-wise mean/std — flag this as a known potential perf issue, not a correctness issue.

---

### Task 3: Band calibration — `calibrate_bands`

**Files:**
- Modify: `backend/app/services/forecast_service.py`
- Test: `backend/test_forecast_service_v2.py` (extend)

**Step 1: Write the failing test (append)**

```python
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
```

**Step 2: Run test to verify it fails**

Run: `cd "/Users/srikrishnasingh/AG1 BB/PEESTOCKS/backend" && source venv/bin/activate && PYTHONPATH=. python test_forecast_service_v2.py`
Expected: `ImportError: cannot import name 'calibrate_bands'`

**Step 3: Write minimal implementation**

Add to `backend/app/services/forecast_service.py`:

```python
def calibrate_bands(residuals_by_horizon: dict, coverage_target: float = 0.90) -> dict:
    """Given empirical (actual - predicted) residuals per horizon day from a
    calibration slice the model never trained on, compute a symmetric half-width
    per horizon day such that predicted +/- half_width covers `coverage_target`
    fraction of those residuals (e.g. the 90th percentile of |residual|).

    Returns {horizon_day: half_width}. Horizon days with no residuals get 0.0
    (caller should treat 0-width bands as "uncalibrated, don't trust" rather
    than a real zero-uncertainty claim).
    """
    half_widths = {}
    for h, residuals in residuals_by_horizon.items():
        residuals = np.asarray(residuals)
        if len(residuals) == 0:
            half_widths[h] = 0.0
            continue
        abs_res = np.abs(residuals)
        half_widths[h] = float(np.percentile(abs_res, coverage_target * 100))
    return half_widths
```

**Step 4: Run test to verify it passes**

Run: `cd "/Users/srikrishnasingh/AG1 BB/PEESTOCKS/backend" && source venv/bin/activate && PYTHONPATH=. python test_forecast_service_v2.py`
Expected: `All checks passed.`

---

### Task 4: Simple mean-only prediction (no MC-dropout)

**Files:**
- Modify: `backend/app/ml/lstm_model.py`
- Test: `backend/test_lstm_model.py` (extend existing file from v1)

**Step 1: Write the failing test (append to existing `backend/test_lstm_model.py`)**

```python
from app.ml.lstm_model import predict_mean

model2 = ForecastLSTM(input_size=6, hidden_size=8, horizon=5)
X2 = torch.randn(4, 60, 6)
pred = predict_mean(model2, X2)

check("predict_mean output shape matches (batch, horizon)", tuple(pred.shape) == (4, 5))
check("predict_mean is deterministic (eval mode, no dropout randomness)",
      np.allclose(predict_mean(model2, X2), predict_mean(model2, X2)))

if failures:
    print(f"\n{len(failures)} check(s) failed: {failures}")
    raise SystemExit(1)
print("\nAll checks passed.")
```

**Step 2: Run test to verify it fails**

Run: `cd "/Users/srikrishnasingh/AG1 BB/PEESTOCKS/backend" && source venv/bin/activate && PYTHONPATH=. python test_lstm_model.py`
Expected: `ImportError: cannot import name 'predict_mean'`

**Step 3: Write minimal implementation**

Add to `backend/app/ml/lstm_model.py`:

```python
def predict_mean(model, X):
    """Single deterministic forward pass (eval mode, dropout off).
    Returns a numpy array, shape (batch, horizon). Used by v2, which gets its
    uncertainty band from empirical calibration (see forecast_service.calibrate_bands)
    rather than MC-dropout — v1's MC-dropout band was proven badly miscalibrated
    in the v1 backtest (5% actual coverage vs 90% target).
    """
    model.eval()
    with torch.no_grad():
        return model(X).numpy()
```

**Step 4: Run test to verify it passes**

Run: `cd "/Users/srikrishnasingh/AG1 BB/PEESTOCKS/backend" && source venv/bin/activate && PYTHONPATH=. python test_lstm_model.py`
Expected: `All checks passed.`

---

### Task 5: v2 training function + manual verification run

**Files:**
- Create: `backend/scripts/train_forecast_v2.py`

This is a standalone script (NOT a Celery task yet — v2 isn't being deployed live in this plan, see scope note at top). It trains a v2 model and saves it for the backtest script in Task 6 to evaluate.

**Step 1:** Write `backend/scripts/train_forecast_v2.py`:

```python
"""PEESTOCK — LSTM Forecast v2 Training (standalone, not yet wired to Celery).

Trains the v2 model: technical-indicator features, NIFTY-relative return target,
5-day horizon. Saves model + calibration band half-widths together. This is a
validation-stage script — v2 is NOT deployed to the live forecasts API/UI by
this script. See docs/plans/2026-06-30-lstm-forecast-v2-design.md for why.

Run directly: python scripts/train_forecast_v2.py
"""
import os
import sys
import time

sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import numpy as np
import pandas as pd
import torch
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.workers.tasks_eod import _get_sync_engine
from app.models.models import Instrument, OhlcvEod
from app.services.forecast_service import (
    build_relative_sequences, calibrate_bands, LOOKBACK, HORIZON_V2, CALIBRATION_DAYS, N_FEATURES,
)
from app.ml.lstm_model import ForecastLSTM, train_one_epoch, predict_mean

MAX_INSTRUMENTS = 200
EPOCHS = 5
BATCH_SIZE = 4096
LR = 0.001
NIFTY_INSTRUMENT_ID = 2222  # confirmed: NIFTY_50, segment IND, real OHLCV history

MODEL_PATH = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "app", "ml", "forecast_lstm_v2.pt"
)
MODEL_PATH = os.path.normpath(MODEL_PATH)


def load_instrument_df(session, instrument_id):
    bars = session.execute(
        select(OhlcvEod).where(OhlcvEod.instrument_id == instrument_id).order_by(OhlcvEod.time.asc())
    ).scalars().all()
    if not bars:
        return None
    return pd.DataFrame({
        "date": [b.time for b in bars],
        "close": [float(b.close) for b in bars],
        "high": [float(b.high) for b in bars],
        "low": [float(b.low) for b in bars],
        "volume": [float(b.volume or 0) for b in bars],
    }).set_index("date")


def main():
    t_start = time.time()
    engine = _get_sync_engine()

    with Session(engine) as session:
        nifty_df = load_instrument_df(session, NIFTY_INSTRUMENT_ID)
        if nifty_df is None:
            print("[train_v2] NIFTY_50 (id=2222) has no OHLCV data — aborting.", flush=True)
            return
        print(f"[train_v2] NIFTY_50 loaded: {len(nifty_df)} bars", flush=True)

        instruments = session.execute(
            select(Instrument).where(Instrument.is_active.is_(True))
        ).scalars().all()
        instruments = instruments[:MAX_INSTRUMENTS]
        total_inst = len(instruments)
        print(f"[train_v2] data prep: {total_inst} active instruments", flush=True)

        all_X, all_y = [], []
        calib_residuals = {h: [] for h in range(1, HORIZON_V2 + 1)}

        for idx, inst in enumerate(instruments, start=1):
            stock_df = load_instrument_df(session, inst.id)
            if stock_df is None:
                continue

            # Inner join on date — only dates both the stock and NIFTY have.
            joined = stock_df.join(nifty_df[["close"]], rsuffix="_nifty", how="inner")
            if len(joined) < LOOKBACK + HORIZON_V2 + CALIBRATION_DAYS + 20:
                continue

            stock_part = joined[["close", "high", "low", "volume"]]
            nifty_close_aligned = joined["close_nifty"]

            # Hold out the last CALIBRATION_DAYS rows from training.
            train_len = len(joined) - CALIBRATION_DAYS
            train_stock = stock_part.iloc[:train_len]
            train_nifty = nifty_close_aligned.iloc[:train_len]

            X, y = build_relative_sequences(train_stock, train_nifty)
            if len(X) > 0:
                all_X.append(X)
                all_y.append(y)

            if idx % 50 == 0 or idx == total_inst:
                pct = idx / total_inst * 100
                print(f"[train_v2] data prep progress: {idx}/{total_inst} ({pct:.1f}%)", flush=True)

        if not all_X:
            print("[train_v2] No training data available — aborting.", flush=True)
            return

        X_train = torch.from_numpy(np.concatenate(all_X, axis=0))
        y_train = torch.from_numpy(np.concatenate(all_y, axis=0))
        print(f"[train_v2] data prep done: {X_train.shape[0]} total training samples", flush=True)

        model = ForecastLSTM(input_size=N_FEATURES, hidden_size=32, num_layers=2, horizon=HORIZON_V2)
        optimizer = torch.optim.Adam(model.parameters(), lr=LR)

        n = X_train.shape[0]
        for epoch in range(EPOCHS):
            perm = torch.randperm(n)
            epoch_loss = 0.0
            n_batches = 0
            for start in range(0, n, BATCH_SIZE):
                idx2 = perm[start:start + BATCH_SIZE]
                loss = train_one_epoch(model, X_train[idx2], y_train[idx2], optimizer)
                epoch_loss += loss
                n_batches += 1
            avg_loss = epoch_loss / max(n_batches, 1)
            elapsed = time.time() - t_start
            print(f"[train_v2] epoch {epoch + 1}/{EPOCHS} avg loss: {avg_loss:.6f} elapsed: {elapsed:.0f}s", flush=True)

        # ── Calibration pass: predict on the held-out calibration slice, collect residuals ──
        print("[train_v2] running calibration pass...", flush=True)
        for inst in instruments:
            stock_df = load_instrument_df(session, inst.id)
            if stock_df is None:
                continue
            joined = stock_df.join(nifty_df[["close"]], rsuffix="_nifty", how="inner")
            if len(joined) < LOOKBACK + HORIZON_V2 + CALIBRATION_DAYS + 20:
                continue

            stock_part = joined[["close", "high", "low", "volume"]]
            nifty_close_aligned = joined["close_nifty"]

            X_calib, y_calib = build_relative_sequences(stock_part, nifty_close_aligned)
            if len(X_calib) == 0:
                continue
            # Only use samples whose target window falls within the last CALIBRATION_DAYS
            n_calib_samples = min(CALIBRATION_DAYS, len(X_calib))
            X_calib_tail = X_calib[-n_calib_samples:]
            y_calib_tail = y_calib[-n_calib_samples:]

            preds = predict_mean(model, torch.from_numpy(X_calib_tail))
            for h in range(1, HORIZON_V2 + 1):
                residual = y_calib_tail[:, h - 1] - preds[:, h - 1]
                calib_residuals[h].extend(residual.tolist())

        half_widths = calibrate_bands(calib_residuals, coverage_target=0.90)
        print(f"[train_v2] calibrated half-widths (fraction of price): {half_widths}", flush=True)

    os.makedirs(os.path.dirname(MODEL_PATH), exist_ok=True)
    torch.save({"state_dict": model.state_dict(), "half_widths": half_widths}, MODEL_PATH)
    print(f"[train_v2] saved model + calibration to {MODEL_PATH}", flush=True)
    print(f"[train_v2] total wall time: {time.time() - t_start:.0f}s", flush=True)


if __name__ == "__main__":
    main()
```

**Step 2: Run it, detached, with progress logging (this is a real training run — expect several minutes based on v1's precedent of ~6-8 min for 200 instruments; v2 does MORE per-instrument work since it computes 6 indicators and does a double pass — train + calibration — so budget up to ~15 min)**

```bash
cd "/Users/srikrishnasingh/AG1 BB/PEESTOCKS/backend" && source venv/bin/activate
nohup env PYTHONPATH=. python -u scripts/train_forecast_v2.py > /tmp/train_v2.log 2>&1 < /dev/null &
disown
echo "launched pid $!"
```

Poll the log periodically (`tail -30 /tmp/train_v2.log`) rather than blocking — do not run this in the foreground where it could be killed by a command timeout. If it's still in the per-instrument Python-loop data-prep phase after ~10 minutes with no epoch output, that's a real perf concern (Task 2's note flagged the unvectorized loop as a possible bottleneck) — investigate before assuming it's just slow, e.g. check CPU usage with `ps -p <pid> -o %cpu,%mem,etime` to confirm it's actively working.

**Step 3: Verify the saved file is well-formed**

Run:
```bash
cd "/Users/srikrishnasingh/AG1 BB/PEESTOCKS/backend" && source venv/bin/activate && PYTHONPATH=. python -c "
import torch
d = torch.load('app/ml/forecast_lstm_v2.pt', map_location='cpu')
print('keys:', d.keys())
print('half_widths:', d['half_widths'])
"
```
Expected: prints `keys: dict_keys(['state_dict', 'half_widths'])` and a dict of 5 half-width values (one per horizon day 1-5), all positive floats.

---

### Task 6: v2 backtest script — the real validation

**Files:**
- Create: `backend/scripts/run_forecast_backtest_v2.py`

This reuses v1's `run_forecast_backtest.py` train/holdout/naive-baseline methodology (already proven sound — it's what caught v1's failure), adapted for v2's feature pipeline and relative-return target.

**Step 1:** Write `backend/scripts/run_forecast_backtest_v2.py`:

```python
"""PEESTOCK — LSTM Forecast v2 Backtest.

Same honest train/holdout methodology as run_forecast_backtest.py (v1), adapted
for v2's feature engineering and NIFTY-relative return target. Trains a model
on data BEFORE a holdout window, evaluates on real future prices the model
never saw, compares against a naive "tomorrow=today" baseline in absolute-price
MAPE terms (un-transforming v2's relative-return predictions using the ACTUAL
realized NIFTY return over the matching window — fair to do in a backtest since
we know history; this is NOT something the live precompute path could do, since
future NIFTY return is unknown at prediction time — see plan Task 6 notes).

Run directly: python scripts/run_forecast_backtest_v2.py
"""
import os
import sys
import time

sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import numpy as np
import pandas as pd
import torch
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.workers.tasks_eod import _get_sync_engine
from app.models.models import Instrument, OhlcvEod
from app.services.forecast_service import (
    build_relative_sequences, compute_feature_frame, LOOKBACK, HORIZON_V2, N_FEATURES,
)
from app.ml.lstm_model import ForecastLSTM, train_one_epoch, predict_mean

MAX_INSTRUMENTS = 200
HOLDOUT_DAYS = 40
EPOCHS = 5
BATCH_SIZE = 4096
LR = 0.001
NIFTY_INSTRUMENT_ID = 2222

BACKTEST_MODEL_PATH = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "app", "ml", "forecast_lstm_v2_backtest.pt"
)
BACKTEST_MODEL_PATH = os.path.normpath(BACKTEST_MODEL_PATH)


def load_instrument_df(session, instrument_id):
    bars = session.execute(
        select(OhlcvEod).where(OhlcvEod.instrument_id == instrument_id).order_by(OhlcvEod.time.asc())
    ).scalars().all()
    if not bars:
        return None
    return pd.DataFrame({
        "date": [b.time for b in bars],
        "close": [float(b.close) for b in bars],
        "high": [float(b.high) for b in bars],
        "low": [float(b.low) for b in bars],
        "volume": [float(b.volume or 0) for b in bars],
    }).set_index("date")


def main():
    t_start = time.time()
    engine = _get_sync_engine()

    with Session(engine) as session:
        nifty_df = load_instrument_df(session, NIFTY_INSTRUMENT_ID)
        if nifty_df is None:
            print("[backtest_v2] NIFTY_50 has no data — aborting.", flush=True)
            return

        instruments = session.execute(
            select(Instrument).where(Instrument.is_active.is_(True))
        ).scalars().all()
        instruments = instruments[:MAX_INSTRUMENTS]
        total_inst = len(instruments)
        print(f"[backtest_v2] data prep: {total_inst} active instruments", flush=True)

        all_X, all_y = [], []
        holdout_data = []  # (symbol, joined_df, train_len)

        for idx, inst in enumerate(instruments, start=1):
            stock_df = load_instrument_df(session, inst.id)
            if stock_df is None:
                continue
            joined = stock_df.join(nifty_df[["close"]], rsuffix="_nifty", how="inner")
            n = len(joined)
            if n < LOOKBACK + HORIZON_V2 + HOLDOUT_DAYS + 20:
                continue

            train_len = n - HOLDOUT_DAYS
            train_stock = joined[["close", "high", "low", "volume"]].iloc[:train_len]
            train_nifty = joined["close_nifty"].iloc[:train_len]

            X, y = build_relative_sequences(train_stock, train_nifty)
            if len(X) > 0:
                all_X.append(X)
                all_y.append(y)

            holdout_data.append((inst.symbol, joined, train_len))

            if idx % 50 == 0 or idx == total_inst:
                pct = idx / total_inst * 100
                print(f"[backtest_v2] data prep progress: {idx}/{total_inst} ({pct:.1f}%)", flush=True)

        if not all_X:
            print("[backtest_v2] No training data — aborting.", flush=True)
            return

        X_train = torch.from_numpy(np.concatenate(all_X, axis=0))
        y_train = torch.from_numpy(np.concatenate(all_y, axis=0))
        print(f"[backtest_v2] data prep done: {X_train.shape[0]} training samples "
              f"(holdout-excluded last {HOLDOUT_DAYS} bars per instrument)", flush=True)

        model = ForecastLSTM(input_size=N_FEATURES, hidden_size=32, num_layers=2, horizon=HORIZON_V2)
        optimizer = torch.optim.Adam(model.parameters(), lr=LR)

        n_samples = X_train.shape[0]
        for epoch in range(EPOCHS):
            perm = torch.randperm(n_samples)
            epoch_loss = 0.0
            n_batches = 0
            for start in range(0, n_samples, BATCH_SIZE):
                idx2 = perm[start:start + BATCH_SIZE]
                loss = train_one_epoch(model, X_train[idx2], y_train[idx2], optimizer)
                epoch_loss += loss
                n_batches += 1
            avg_loss = epoch_loss / max(n_batches, 1)
            elapsed = time.time() - t_start
            print(f"[backtest_v2] epoch {epoch + 1}/{EPOCHS} avg loss: {avg_loss:.6f} elapsed: {elapsed:.0f}s", flush=True)

        os.makedirs(os.path.dirname(BACKTEST_MODEL_PATH), exist_ok=True)
        torch.save(model.state_dict(), BACKTEST_MODEL_PATH)
        print(f"[backtest_v2] backtest model saved ({n_samples} samples)", flush=True)

        # ── Evaluation on held-out region ──
        print(f"[backtest_v2] starting evaluation over {len(holdout_data)} instruments", flush=True)

        ape_by_horizon = {h: [] for h in range(1, HORIZON_V2 + 1)}
        naive_ape_by_horizon = {h: [] for h in range(1, HORIZON_V2 + 1)}
        coverage_hits = 0
        coverage_total = 0

        n_inst_evaluated = 0
        for sidx, (symbol, joined, train_len) in enumerate(holdout_data, start=1):
            n_total = len(joined)
            stock_part = joined[["close", "high", "low", "volume"]]
            nifty_close_aligned = joined["close_nifty"]
            close_arr = stock_part["close"].to_numpy(dtype=np.float64)
            nifty_arr = nifty_close_aligned.to_numpy(dtype=np.float64)

            feat = compute_feature_frame(stock_part)
            feat_arr = feat.to_numpy(dtype=np.float64)

            any_eval = False
            anchor_start = max(LOOKBACK - 1, train_len)
            anchor_end = n_total - 1 - HORIZON_V2
            if anchor_end < anchor_start:
                continue

            for t in range(anchor_start, anchor_end + 1):
                window = feat_arr[t - LOOKBACK + 1: t + 1]
                if np.isnan(window).any():
                    continue
                mean_w = window.mean(axis=0)
                std_w = window.std(axis=0)
                std_w = np.where(std_w > 1e-8, std_w, 1.0)
                X_in = ((window - mean_w) / std_w).astype(np.float32).reshape(1, LOOKBACK, N_FEATURES)

                pred = predict_mean(model, torch.from_numpy(X_in))[0]  # (HORIZON_V2,) relative-return prediction

                stock_anchor = close_arr[t]
                nifty_anchor = nifty_arr[t]
                if stock_anchor <= 0 or nifty_anchor <= 0:
                    continue

                naive_guess = stock_anchor

                for h in range(1, HORIZON_V2 + 1):
                    future_idx = t + h
                    if future_idx >= n_total:
                        continue
                    actual_price = close_arr[future_idx]
                    actual_nifty = nifty_arr[future_idx]
                    if actual_price <= 0:
                        continue

                    # Un-transform: add back the REALIZED nifty return (fair in
                    # backtest since it's historical fact) to get a comparable
                    # absolute-price prediction.
                    realized_nifty_return = (actual_nifty - nifty_anchor) / nifty_anchor
                    predicted_total_return = pred[h - 1] + realized_nifty_return
                    pred_price = stock_anchor * (1 + predicted_total_return)

                    ape = abs(pred_price - actual_price) / actual_price * 100
                    ape_by_horizon[h].append(ape)

                    naive_ape = abs(naive_guess - actual_price) / actual_price * 100
                    naive_ape_by_horizon[h].append(naive_ape)

                    any_eval = True

            if any_eval:
                n_inst_evaluated += 1

            if sidx % 50 == 0 or sidx == len(holdout_data):
                print(f"[backtest_v2] evaluation progress: {sidx}/{len(holdout_data)} instruments "
                      f"({n_inst_evaluated} evaluable so far)", flush=True)

        all_ape = [v for h in ape_by_horizon.values() for v in h]
        all_naive_ape = [v for h in naive_ape_by_horizon.values() for v in h]

        print("\n" + "=" * 70, flush=True)
        print("[backtest_v2] RESULTS", flush=True)
        print("=" * 70, flush=True)
        print(f"Instruments with evaluable holdout points: {n_inst_evaluated} / {len(holdout_data)}", flush=True)
        print(f"Total instrument-day-horizon predictions evaluated: {len(all_ape)}", flush=True)

        if not all_ape:
            print("[backtest_v2] No evaluable predictions — aborting report.", flush=True)
            return

        print(f"\nOverall v2 LSTM MAPE: {np.mean(all_ape):.3f}%", flush=True)
        print(f"Overall naive ('tomorrow=today') MAPE: {np.mean(all_naive_ape):.3f}%", flush=True)

        print("\nPer-horizon-day MAPE (v2 LSTM vs naive):", flush=True)
        print(f"{'Day':>5} {'n':>8} {'v2 MAPE':>12} {'Naive MAPE':>12}", flush=True)
        for h in range(1, HORIZON_V2 + 1):
            n_h = len(ape_by_horizon[h])
            lstm_mape_h = np.mean(ape_by_horizon[h]) if n_h else float("nan")
            naive_mape_h = np.mean(naive_ape_by_horizon[h]) if n_h else float("nan")
            print(f"{h:>5} {n_h:>8} {lstm_mape_h:>11.3f}% {naive_mape_h:>11.3f}%", flush=True)

        elapsed = time.time() - t_start
        print(f"\n[backtest_v2] total wall time: {elapsed:.0f}s", flush=True)
        print("=" * 70, flush=True)


if __name__ == "__main__":
    main()
```

**Step 2: Run it, detached, polling the log (real training + evaluation — budget up to ~20 min given v2's heavier per-sample work; do not run in foreground)**

```bash
cd "/Users/srikrishnasingh/AG1 BB/PEESTOCKS/backend" && source venv/bin/activate
nohup env PYTHONPATH=. python -u scripts/run_forecast_backtest_v2.py > /tmp/backtest_v2.log 2>&1 < /dev/null &
disown
echo "launched pid $!"
```

**Step 3: Report the real numbers — honestly, no editorializing**

Once `[backtest_v2] RESULTS` appears in the log, read the actual overall v2 MAPE vs. naive MAPE and the per-horizon breakdown. Per the approved design, success = v2 MAPE beats naive MAPE overall, any margin. Report the true result whichever way it goes — if v2 still doesn't beat naive, that's a valid and important finding (it would suggest the signal-to-noise problem is deeper than feature choice, e.g. needs more data, different architecture, or the 5-day horizon is still too long for this feature set), not a failure of this task to report honestly.

---

### Task 7: Decision checkpoint (no code — human decision)

Per the plan's scope note, v2 is NOT wired into the live API/chart/assistant by this plan. After Task 6's real backtest numbers are in:

- **If v2 beats naive baseline:** that's the trigger to write a follow-up plan for deploying v2 live (new Celery tasks, updating the `forecasts` table or adding a `model_version` distinction, updating the API/UI to use it) — a separate, smaller plan at that point, not assumed here.
- **If v2 still doesn't beat naive:** report the result plainly and revisit the deferred directions from the original design (per-sector segmentation, more training data, longer training, different horizon) as the next iteration — or accept that daily-resolution stock forecasting may not be a defensible feature to market at all without much larger investment, and consider repositioning the "AI" angle of the product around something more achievable (e.g. pattern recognition confidence scoring, which your scanner engine already does reliably, rather than price prediction).

No code changes in this task — it's a checkpoint to prevent silently shipping an unvalidated model, which is exactly what happened with v1.
