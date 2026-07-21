# Deploy v2 LSTM Forecast to Production Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace v1's live forecast pipeline with the validated v2 model (beats naive baseline at all 5 horizons, well-calibrated bands) — vectorized for full-dataset scale, wired into the existing Celery/API/UI with zero schema or endpoint changes, v1 code removed.

**Architecture:** Vectorize `build_relative_sequences` first (numpy `sliding_window_view`, matching v1's proven technique) so a full 2,281-stock retrain finishes in minutes instead of an hour+. Swap `tasks_forecast.py`'s task bodies to call v2 functions instead of v1, writing `model_version="lstm-v2"` into the unchanged `forecasts` table — the API, chart overlay, and AI Assistant already read generically and need no changes. Run a real production retrain via the existing Redis+Celery worker+beat stack. Remove v1's now-dead code.

**Tech Stack:** Same as before — PyTorch, pandas, NumPy, SQLAlchemy, Celery/Redis (already running in this environment: Redis pid via `redislite`, Celery worker pid, Celery beat pid — confirm still running with `ps aux | grep celery` before Task 3, restart if needed using the same `nohup ... & disown` pattern used earlier in this project).

---

### Task 1: Vectorize `build_relative_sequences`

**Files:**
- Modify: `backend/app/services/forecast_service.py:94-185`
- Test: `backend/test_forecast_service_v2.py` (extend)

The current implementation (lines 137-185) loops over samples in Python — correct (validated by the v2 backtest) but slow at scale. Rewrite using vectorized sliding-window operations while preserving identical behavior: same NaN/non-positive filtering per sample, same per-window z-score normalization, same output shapes.

**Step 1: Add a regression test that pins current (loop-based) behavior before touching it**

Append to `backend/test_forecast_service_v2.py`:

```python
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

# This fingerprint is captured BEFORE vectorization. After vectorizing,
# re-run this same block and confirm the fingerprint is IDENTICAL — that's
# the real regression check (not asserted automatically here since the
# "before" value isn't known until you run this once; see Step 2 below).
```

**Step 2: Run it once, BEFORE vectorizing, to capture the baseline fingerprint**

Run: `cd "/Users/srikrishnasingh/AG1 BB/PEESTOCKS/backend" && source venv/bin/activate && PYTHONPATH=. python test_forecast_service_v2.py`

Expected: all existing checks still pass, plus new output lines:
```
[fingerprint] current build_relative_sequences output: <some 64-char hex string>
[fingerprint] shapes: X=(116, 60, 6), y=(116, 5)
```

**Write down the exact fingerprint hex string and shape — you will compare against it after vectorizing.** This is the actual regression test; the hash must match exactly after the rewrite, or the vectorization introduced a numeric difference that needs investigating before proceeding.

**Step 3: Rewrite the function body (lines 137-185) with vectorized operations**

Replace the loop-based section of `build_relative_sequences` (keep the function signature, docstring, and lines 114-136 — the length-check, feature computation, and warmup-trimming — unchanged) with:

```python
    n_samples = usable_n - min_required + 1
    if n_samples <= 0:
        return np.empty((0, LOOKBACK, N_FEATURES)), np.empty((0, HORIZON_V2))

    # Vectorized sliding windows over the warmup-trimmed feature array.
    # shape: (n_samples, LOOKBACK, N_FEATURES)
    feat_windows = sliding_window_view(feat_usable, LOOKBACK, axis=0)[:n_samples]
    # sliding_window_view with axis=0 puts the window dimension LAST by
    # default for the windowed axis; feat_usable is (T, N_FEATURES), so the
    # result of sliding_window_view(feat_usable, LOOKBACK, axis=0) is
    # (T-LOOKBACK+1, N_FEATURES, LOOKBACK) — transpose the last two axes to
    # get the (n_samples, LOOKBACK, N_FEATURES) shape the rest of this
    # function (and all downstream callers) expect.
    feat_windows = np.transpose(feat_windows, (0, 2, 1))  # (n_samples, LOOKBACK, N_FEATURES)

    anchor_idx = np.arange(n_samples) + LOOKBACK - 1  # (n_samples,)
    stock_anchor = stock_close_usable[anchor_idx]      # (n_samples,)
    nifty_anchor = nifty_close_usable[anchor_idx]      # (n_samples,)

    # future_idx[i, h] = anchor_idx[i] + 1 + h, for h in 0..HORIZON_V2-1
    h_range = np.arange(HORIZON_V2)
    future_idx = anchor_idx[:, None] + 1 + h_range[None, :]  # (n_samples, HORIZON_V2)

    future_stock = stock_close_usable[future_idx]  # (n_samples, HORIZON_V2)
    future_nifty = nifty_close_usable[future_idx]  # (n_samples, HORIZON_V2)

    # Validity mask: same filtering rules as the original loop — no NaN in
    # the feature window, positive anchor prices, no NaN/non-positive future
    # prices. A sample is valid only if ALL these hold.
    window_valid = ~np.isnan(feat_windows).any(axis=(1, 2))  # (n_samples,)
    anchor_valid = (stock_anchor > 0) & (nifty_anchor > 0)
    future_valid = (
        ~np.isnan(future_stock).any(axis=1)
        & ~np.isnan(future_nifty).any(axis=1)
        & (future_stock > 0).all(axis=1)
        & (future_nifty > 0).all(axis=1)
    )
    valid = window_valid & anchor_valid & future_valid  # (n_samples,)

    if not valid.any():
        return np.empty((0, LOOKBACK, N_FEATURES)), np.empty((0, HORIZON_V2))

    feat_windows_v = feat_windows[valid]
    stock_anchor_v = stock_anchor[valid][:, None]   # (n_valid, 1) for broadcasting
    nifty_anchor_v = nifty_anchor[valid][:, None]
    future_stock_v = future_stock[valid]
    future_nifty_v = future_nifty[valid]

    mean = feat_windows_v.mean(axis=1, keepdims=True)  # (n_valid, 1, N_FEATURES)
    std = feat_windows_v.std(axis=1, keepdims=True)
    std = np.where(std > 1e-8, std, 1.0)
    X = ((feat_windows_v - mean) / std).astype(np.float32)

    stock_ret = (future_stock_v - stock_anchor_v) / stock_anchor_v
    nifty_ret = (future_nifty_v - nifty_anchor_v) / nifty_anchor_v
    y = (stock_ret - nifty_ret).astype(np.float32)

    return X, y
```

Add `from numpy.lib.stride_tricks import sliding_window_view` to the top of `forecast_service.py` if not already imported (check first — v1's code already imports this at the top of the file, so it should already be available; just confirm).

**Step 4: Re-run the test and confirm the fingerprint matches exactly**

Run: `cd "/Users/srikrishnasingh/AG1 BB/PEESTOCKS/backend" && source venv/bin/activate && PYTHONPATH=. python test_forecast_service_v2.py`

Expected: all checks pass (including the original Task 1-3 checks from before), AND the new fingerprint line:
```
[fingerprint] current build_relative_sequences output: <hash>
[fingerprint] shapes: X=(116, 60, 6), y=(116, 5)
```
**must be byte-identical to the value captured in Step 2.** If it differs, the vectorization changed numeric behavior — do not proceed until you've found and fixed the discrepancy (common culprits: `sliding_window_view` axis/transpose ordering, broadcasting shape mismatches, or floating-point operation order differences large enough to matter after rounding to 5 decimals — investigate which).

**Step 5: Validate against real data — compare performance, not just correctness**

Run a quick timing comparison against real DB data (200 instruments, matching the validated backtest scope) to confirm the vectorization actually delivers a speedup:

```bash
cd "/Users/srikrishnasingh/AG1 BB/PEESTOCKS/backend" && source venv/bin/activate && PYTHONPATH=. python -c "
import time
from sqlalchemy import select
from sqlalchemy.orm import Session
from app.workers.tasks_eod import _get_sync_engine
from app.models.models import Instrument, OhlcvEod
from app.services.forecast_service import build_relative_sequences, LOOKBACK, HORIZON_V2, CALIBRATION_DAYS
import pandas as pd

engine = _get_sync_engine()
with Session(engine) as session:
    nifty_bars = session.execute(select(OhlcvEod).where(OhlcvEod.instrument_id==2222).order_by(OhlcvEod.time.asc())).scalars().all()
    nifty_df = pd.DataFrame({'date':[b.time for b in nifty_bars],'close':[float(b.close) for b in nifty_bars]}).set_index('date')

    instruments = session.execute(select(Instrument).where(Instrument.is_active.is_(True))).scalars().all()[:200]
    t0 = time.time()
    total_samples = 0
    for inst in instruments:
        bars = session.execute(select(OhlcvEod).where(OhlcvEod.instrument_id==inst.id).order_by(OhlcvEod.time.asc())).scalars().all()
        if not bars: continue
        df = pd.DataFrame({'date':[b.time for b in bars],'close':[float(b.close) for b in bars],'high':[float(b.high) for b in bars],'low':[float(b.low) for b in bars],'volume':[float(b.volume or 0) for b in bars]}).set_index('date')
        joined = df.join(nifty_df[['close']], rsuffix='_nifty', how='inner')
        if len(joined) < LOOKBACK+HORIZON_V2+CALIBRATION_DAYS+20: continue
        train_len = len(joined) - CALIBRATION_DAYS
        stock_part = joined[['close','high','low','volume']].iloc[:train_len]
        nifty_part = joined['close_nifty'].iloc[:train_len]
        X, y = build_relative_sequences(stock_part, nifty_part)
        total_samples += len(X)
    elapsed = time.time() - t0
    print(f'200 instruments, {total_samples} samples, {elapsed:.1f}s ({elapsed/200*1000:.1f}ms/instrument)')
"
```

Expected: noticeably faster than the original loop-based version's data-prep phase (which took ~3.5 minutes / 210s for 200 instruments in the validated v2 backtest run — i.e. ~1050ms/instrument). The vectorized version should be well under that, ideally under 10-20ms/instrument given it's now mostly numpy array operations instead of a Python loop. Report the actual number — don't assume, measure.

---

### Task 2: Swap `tasks_forecast.py` to call v2 logic

**Files:**
- Modify: `backend/app/workers/tasks_forecast.py` (full rewrite of `precompute_forecasts` and `retrain_forecast_model` bodies)

This task changes the production Celery tasks to use v2's feature engineering, relative-return model, and calibrated bands — while keeping the same task names, same `forecasts` table, same beat schedule (no changes needed to `celery_app.py`).

**Step 1:** Read the current `backend/app/workers/tasks_forecast.py` in full (it was last modified during v1's build — confirm current state before rewriting) and `backend/scripts/train_forecast_v2.py` / `backend/scripts/run_forecast_backtest_v2.py` (the validated reference implementations for the training/inference logic you're porting into the production task).

**Step 2:** Rewrite `backend/app/workers/tasks_forecast.py`:

```python
"""Celery tasks for LSTM price forecasting: training and batch inference.

v2: technical-indicator features (RSI/MACD/SMA-distance/Bollinger-%B/relative-
volume/daily-return), NIFTY-relative excess-return target, empirically
calibrated confidence bands. Validated via backend/scripts/run_forecast_backtest_v2.py
and backend/scripts/check_band_coverage_v2.py — beats naive baseline at all 5
horizon days, ~90% band coverage. v1 (price/volume only, absolute-price target,
MC-dropout bands) is retired; see docs/plans/2026-06-30-lstm-forecast-v2-deploy-design.md.
"""
import logging
import os
from datetime import date

import numpy as np
import pandas as pd
import torch
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.workers.celery_app import celery_app
from app.workers.tasks_eod import _get_sync_engine
from app.models.models import Instrument, OhlcvEod, Forecast
from app.services.forecast_service import (
    compute_feature_frame, build_relative_sequences, calibrate_bands,
    LOOKBACK, HORIZON_V2, CALIBRATION_DAYS, N_FEATURES,
)
from app.ml.lstm_model import ForecastLSTM, train_one_epoch, predict_mean

logger = logging.getLogger(__name__)

MODEL_VERSION = "lstm-v2"
NIFTY_INSTRUMENT_ID = 2222
MODEL_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "ml", "forecast_lstm_v2.pt")
MODEL_PATH = os.path.normpath(MODEL_PATH)


def _load_instrument_df(session, instrument_id, limit=None):
    q = select(OhlcvEod).where(OhlcvEod.instrument_id == instrument_id)
    q = q.order_by(OhlcvEod.time.desc() if limit else OhlcvEod.time.asc())
    if limit:
        q = q.limit(limit)
    bars = session.execute(q).scalars().all()
    if not bars:
        return None
    if limit:
        bars = list(reversed(bars))
    return pd.DataFrame({
        "date": [b.time for b in bars],
        "close": [float(b.close) for b in bars],
        "high": [float(b.high) for b in bars],
        "low": [float(b.low) for b in bars],
        "volume": [float(b.volume or 0) for b in bars],
    }).set_index("date")


@celery_app.task(name="app.workers.tasks_forecast.precompute_forecasts")
def precompute_forecasts():
    today = date.today()
    written = 0
    skipped = 0

    try:
        saved = torch.load(MODEL_PATH, map_location="cpu")
    except FileNotFoundError:
        logger.warning("No trained v2 model found at %s; skipping precompute. Run retrain_forecast_model first.", MODEL_PATH)
        return {"written": 0, "skipped": 0, "error": "model not found"}

    model = ForecastLSTM(input_size=N_FEATURES, hidden_size=32, num_layers=2, horizon=HORIZON_V2)
    model.load_state_dict(saved["state_dict"])
    half_widths = saved["half_widths"]

    engine = _get_sync_engine()
    with Session(engine) as session:
        nifty_df = _load_instrument_df(session, NIFTY_INSTRUMENT_ID, limit=LOOKBACK + 25)
        if nifty_df is None:
            logger.error("NIFTY_50 (id=%s) has no data; aborting precompute.", NIFTY_INSTRUMENT_ID)
            return {"written": 0, "skipped": 0, "error": "no nifty data"}

        instruments = session.execute(
            select(Instrument).where(Instrument.is_active.is_(True))
        ).scalars().all()

        total_inst = len(instruments)
        print(f"[precompute] {total_inst} active instruments", flush=True)
        for idx, inst in enumerate(instruments, start=1):
            stock_df = _load_instrument_df(session, inst.id, limit=LOOKBACK + 25)
            if stock_df is None:
                skipped += 1
                continue

            joined = stock_df.join(nifty_df[["close"]], rsuffix="_nifty", how="inner")
            if len(joined) < LOOKBACK:
                skipped += 1
                continue

            stock_part = joined[["close", "high", "low", "volume"]].iloc[-LOOKBACK:]
            feat = compute_feature_frame(stock_part)
            if feat.isna().any().any():
                # Not enough warmup history for a clean indicator window —
                # same "insufficient_history" case the API already handles
                # via a 404 when no forecast row exists for a symbol.
                skipped += 1
                continue

            window = feat.to_numpy(dtype=np.float64)
            mean = window.mean(axis=0)
            std = window.std(axis=0)
            std = np.where(std > 1e-8, std, 1.0)
            X = ((window - mean) / std).astype(np.float32).reshape(1, LOOKBACK, N_FEATURES)

            pred = predict_mean(model, torch.from_numpy(X))[0]  # (HORIZON_V2,) predicted alpha per day

            anchor_price = float(stock_part["close"].iloc[-1])
            if anchor_price <= 0:
                skipped += 1
                continue

            session.query(Forecast).filter(
                Forecast.instrument_id == inst.id,
                Forecast.as_of_date == today,
            ).delete()

            for day_idx in range(HORIZON_V2):
                h = day_idx + 1
                alpha = float(pred[day_idx])
                hw = half_widths.get(h, half_widths.get(str(h), 0.0))

                # Flat-NIFTY assumption for live display: future NIFTY return
                # is unknown at prediction time (unlike the backtest, which
                # could use the REALIZED return since it's historical fact).
                # predicted_close treats the model's predicted alpha as the
                # expected price move, i.e. assumes the market itself doesn't
                # move over the forecast window. See deploy design doc.
                pred_price = anchor_price * (1 + alpha)
                lower_price = anchor_price * (1 + alpha - hw)
                upper_price = anchor_price * (1 + alpha + hw)

                session.add(Forecast(
                    instrument_id=inst.id,
                    as_of_date=today,
                    horizon_day=h,
                    predicted_close=round(pred_price, 2),
                    lower_band=round(lower_price, 2),
                    upper_band=round(upper_price, 2),
                    model_version=MODEL_VERSION,
                ))
            written += 1

            if idx % 200 == 0 or idx == total_inst:
                pct = idx / total_inst * 100
                print(f"[precompute] progress: {idx}/{total_inst} ({pct:.1f}%)", flush=True)

        session.commit()

    logger.info("v2 forecast precompute done: %d written, %d skipped", written, skipped)
    return {"written": written, "skipped": skipped}


@celery_app.task(name="app.workers.tasks_forecast.retrain_forecast_model")
def retrain_forecast_model(max_instruments=None):
    """max_instruments: optional cap for fast local verification runs only.
    Production Celery schedule always calls this with no argument (full dataset).
    """
    engine = _get_sync_engine()

    with Session(engine) as session:
        nifty_df = _load_instrument_df(session, NIFTY_INSTRUMENT_ID)
        if nifty_df is None:
            logger.error("NIFTY_50 has no data; aborting retrain.")
            return {"trained": False, "reason": "no nifty data"}

        instruments = session.execute(
            select(Instrument).where(Instrument.is_active.is_(True))
        ).scalars().all()
        if max_instruments:
            instruments = instruments[:max_instruments]

        total_inst = len(instruments)
        print(f"[retrain] data prep: {total_inst} active instruments", flush=True)

        all_X, all_y = [], []
        calib_residuals = {h: [] for h in range(1, HORIZON_V2 + 1)}
        instrument_dfs = {}  # cache for the calibration pass below

        for idx, inst in enumerate(instruments, start=1):
            stock_df = _load_instrument_df(session, inst.id)
            if stock_df is None:
                continue
            joined = stock_df.join(nifty_df[["close"]], rsuffix="_nifty", how="inner")
            if len(joined) < LOOKBACK + HORIZON_V2 + CALIBRATION_DAYS + 20:
                continue

            instrument_dfs[inst.id] = joined

            stock_part = joined[["close", "high", "low", "volume"]]
            nifty_part = joined["close_nifty"]
            train_len = len(joined) - CALIBRATION_DAYS
            train_stock = stock_part.iloc[:train_len]
            train_nifty = nifty_part.iloc[:train_len]

            X, y = build_relative_sequences(train_stock, train_nifty)
            if len(X) > 0:
                all_X.append(X)
                all_y.append(y)

            if idx % 200 == 0 or idx == total_inst:
                pct = idx / total_inst * 100
                print(f"[retrain] data prep progress: {idx}/{total_inst} ({pct:.1f}%)", flush=True)

        if not all_X:
            logger.warning("No training data available; aborting retrain.")
            return {"trained": False, "reason": "no data"}

        X_train = torch.from_numpy(np.concatenate(all_X, axis=0))
        y_train = torch.from_numpy(np.concatenate(all_y, axis=0))
        print(f"[retrain] data prep done: {X_train.shape[0]} total training samples", flush=True)

        model = ForecastLSTM(input_size=N_FEATURES, hidden_size=32, num_layers=2, horizon=HORIZON_V2)
        optimizer = torch.optim.Adam(model.parameters(), lr=0.001)

        batch_size = 4096
        n = X_train.shape[0]
        epochs = 5
        for epoch in range(epochs):
            perm = torch.randperm(n)
            epoch_loss = 0.0
            n_batches = 0
            for start in range(0, n, batch_size):
                idx2 = perm[start:start + batch_size]
                loss = train_one_epoch(model, X_train[idx2], y_train[idx2], optimizer)
                epoch_loss += loss
                n_batches += 1
            avg_loss = epoch_loss / max(n_batches, 1)
            print(f"[retrain] epoch {epoch + 1}/{epochs} avg loss: {avg_loss:.6f}", flush=True)
            logger.info("Epoch %d/%d avg loss: %.6f", epoch + 1, epochs, avg_loss)

        print("[retrain] running calibration pass...", flush=True)
        for inst_id, joined in instrument_dfs.items():
            stock_part = joined[["close", "high", "low", "volume"]]
            nifty_part = joined["close_nifty"]
            X_calib, y_calib = build_relative_sequences(stock_part, nifty_part)
            if len(X_calib) == 0:
                continue
            n_calib = min(CALIBRATION_DAYS, len(X_calib))
            X_tail = X_calib[-n_calib:]
            y_tail = y_calib[-n_calib:]
            preds = predict_mean(model, torch.from_numpy(X_tail))
            for h in range(1, HORIZON_V2 + 1):
                residual = y_tail[:, h - 1] - preds[:, h - 1]
                calib_residuals[h].extend(residual.tolist())

        half_widths = calibrate_bands(calib_residuals, coverage_target=0.90)
        print(f"[retrain] calibrated half-widths: {half_widths}", flush=True)

    os.makedirs(os.path.dirname(MODEL_PATH), exist_ok=True)
    torch.save({"state_dict": model.state_dict(), "half_widths": half_widths}, MODEL_PATH)
    logger.info("v2 model saved to %s (%d training samples)", MODEL_PATH, n)
    return {"trained": True, "samples": n}
```

Note on `instrument_dfs` caching: the production retrain holds all instruments' joined DataFrames in memory for the calibration pass (avoiding a second DB round-trip per instrument). At full 2,281-instrument scale this is more memory than the 200-instrument validation run used — if this causes memory pressure during Task 3's real run, the fallback is to re-query each instrument's data in the calibration loop instead of caching (slower, less memory). Don't pre-optimize; only change this if Task 3 actually shows a memory problem.

**Step 3: Smoke-test the rewritten module imports cleanly and the small-scale path still works**

Run:
```bash
cd "/Users/srikrishnasingh/AG1 BB/PEESTOCKS/backend" && source venv/bin/activate && PYTHONPATH=. python -c "
from app.workers.tasks_forecast import retrain_forecast_model, precompute_forecasts
print(retrain_forecast_model(max_instruments=20))
print(precompute_forecasts())
"
```
Expected: `{'trained': True, 'samples': N}` with N > 0, then `{'written': M, 'skipped': K}` with M > 0 — a fast smoke test (20 instruments) confirming the rewritten task functions work end-to-end before committing to the full 2,281-instrument run in Task 3.

**Step 4: Sanity-check written forecast rows**

```bash
sqlite3 "/Users/srikrishnasingh/AG1 BB/PEESTOCKS/peestock.db" "SELECT i.symbol, f.model_version, f.horizon_day, f.predicted_close, f.lower_band, f.upper_band FROM forecasts f JOIN instruments i ON f.instrument_id=i.id WHERE f.model_version='lstm-v2' ORDER BY i.symbol, f.horizon_day LIMIT 10;"
```
Expected: 10 rows with `model_version='lstm-v2'`, plausible prices (close to the instrument's recent actual price), `lower_band < predicted_close < upper_band` for every row.

---

### Task 3: Full production retrain (2,281 instruments)

**Files:** none (operational task, no code changes)

**Step 1:** Confirm the existing Celery/Redis infrastructure is still running (it was set up earlier in this project session):

```bash
ps aux | grep -E "redis-server|celery" | grep -v grep
```
Expected: a `redis-server` process, a `celery ... worker` process, and a `celery ... beat` process. If any are missing, restart them using the same pattern from earlier in this project:
```bash
cd "/Users/srikrishnasingh/AG1 BB/PEESTOCKS/backend" && source venv/bin/activate
REDIS_BIN="venv/lib/python3.9/site-packages/redislite/bin/redis-server"
nohup "$REDIS_BIN" --port 6379 --daemonize no > /tmp/redis_restart.log 2>&1 < /dev/null & disown
sleep 1
nohup env PYTHONPATH=. celery -A app.workers.celery_app worker --loglevel=info > /tmp/celery_worker_restart.log 2>&1 < /dev/null & disown
nohup env PYTHONPATH=. celery -A app.workers.celery_app beat --loglevel=info > /tmp/celery_beat_restart.log 2>&1 < /dev/null & disown
sleep 4
ps aux | grep -E "redis-server|celery" | grep -v grep
```

**Step 2:** Queue the real production retrain through the actual Celery worker (not a direct function call — this proves the deployed task works exactly as it will when the beat schedule fires it):

```bash
cd "/Users/srikrishnasingh/AG1 BB/PEESTOCKS/backend" && source venv/bin/activate && PYTHONPATH=. python -c "
from app.workers.tasks_forecast import retrain_forecast_model
result = retrain_forecast_model.delay()
print('Task queued, id:', result.id)
"
```

This does NOT block — it returns immediately after queuing. Do not call `.get()` and wait synchronously; the full dataset run could take well over the default task/command timeout. Instead, poll the Celery worker's log file to track progress:

```bash
tail -f <path to wherever the worker's stdout/log is being captured — check what was used when the worker was originally started in this session, likely a log file in the scratchpad directory>
```

Given the vectorization from Task 1, data prep across 2,281 instruments should now take low minutes rather than 30-45+. Training (5 epochs over a dataset ~11x larger than the 200-instrument validation run, i.e. likely 6-8 million+ samples) will still take real time — budget realistically based on the 200-instrument run's actual epoch timing (recorded in this project's history: ~65-95s/epoch for ~630K samples) scaled up; do not assume a specific number, measure by watching the log.

**Step 3: Once training completes, queue the precompute job**

```bash
cd "/Users/srikrishnasingh/AG1 BB/PEESTOCKS/backend" && source venv/bin/activate && PYTHONPATH=. python -c "
from app.workers.tasks_forecast import precompute_forecasts
result = precompute_forecasts.delay()
print('Task queued, id:', result.id)
"
```

**Step 4: Verify final results**

```bash
sqlite3 "/Users/srikrishnasingh/AG1 BB/PEESTOCKS/peestock.db" "SELECT model_version, COUNT(DISTINCT instrument_id) AS symbols, COUNT(*) AS rows FROM forecasts GROUP BY model_version;"
```
Expected: a row for `lstm-v2` with a symbol count meaningfully larger than the 200-instrument validation run's 191 (closer to, though likely not exactly, 2,281 — some instruments will still lack enough history, same as before). Old `lstm-v1` rows may still exist from before this deployment; that's fine, they're simply stale and will never be queried again since the API always reads the *latest* `as_of_date` per instrument, which will now be v2.

---

### Task 4: Remove v1 dead code

**Files:**
- Modify: `backend/app/services/forecast_service.py:1-49` (remove `build_sequences`, `LOOKBACK`, `HORIZON`)
- Modify: `backend/app/ml/lstm_model.py` (remove `predict_with_band`)
- Delete: `backend/app/ml/forecast_lstm.pt` (v1's saved model file, now unused)

**Step 1:** Before removing anything, grep for any remaining references to confirm nothing else depends on this code:

```bash
grep -rn "build_sequences\b" "/Users/srikrishnasingh/AG1 BB/PEESTOCKS/backend" --include="*.py" | grep -v "build_relative_sequences"
grep -rn "predict_with_band" "/Users/srikrishnasingh/AG1 BB/PEESTOCKS/backend" --include="*.py"
grep -rn "from app.services.forecast_service import.*LOOKBACK\b" "/Users/srikrishnasingh/AG1 BB/PEESTOCKS/backend" --include="*.py"
```

If any of these turn up references outside `forecast_service.py`/`lstm_model.py` themselves and their own test files, STOP and investigate before deleting — something else may still depend on v1 code that wasn't accounted for in this plan.

Note: `backend/test_forecast_service.py` (v1's original test, from the very first forecast feature build) and `backend/test_lstm_model.py`'s v1-era checks (the ones testing `predict_with_band`) will break once this code is removed — that's expected and correct, since v1 is being retired. Update/remove the now-obsolete parts of those test files in this same task rather than leaving failing tests behind.

**Step 2:** Remove `build_sequences`, `LOOKBACK`, `HORIZON` from `forecast_service.py` (lines 1-49 in the current file — re-read the file first to confirm exact current line numbers before deleting, they may have shifted slightly after Task 1's edit). Keep the `# ── v2: technical-indicator feature engineering ─────────────` section and everything below it.

**Step 3:** Remove `predict_with_band` from `lstm_model.py`. Keep `ForecastLSTM`, `train_one_epoch`, `predict_mean`.

**Step 4:** Delete the old model file:
```bash
rm "/Users/srikrishnasingh/AG1 BB/PEESTOCKS/backend/app/ml/forecast_lstm.pt"
```

**Step 5:** Update `backend/test_forecast_service.py` and the v1-era section of `backend/test_lstm_model.py` to remove tests for the now-deleted `build_sequences`/`predict_with_band` (or delete `test_forecast_service.py` entirely if it tested nothing but v1 code — check its contents first).

**Step 6: Run the full remaining test suite to confirm nothing broke**

```bash
cd "/Users/srikrishnasingh/AG1 BB/PEESTOCKS/backend" && source venv/bin/activate
PYTHONPATH=. python test_forecast_service_v2.py
PYTHONPATH=. python test_lstm_model.py
PYTHONPATH=. python -c "from app.main import app; print('app imports ok')"
PYTHONPATH=. python -c "from app.workers.tasks_forecast import retrain_forecast_model, precompute_forecasts; print('tasks import ok')"
```
Expected: all pass, no import errors.

---

### Task 5: UI note for the flat-market assumption

**Files:**
- Modify: `frontend/src/app/dashboard/charts/page.js:5482-5488`

**Step 1:** The existing forecast badge block is:

```jsx
{activeIndicators.includes('forecast_lstm') && forecastData && (
  <div style={{marginBottom:'6px'}}>
    <span style={{ fontSize: '11px', color: forecastData.is_stale ? '#f59e0b' : '#9ca3af', marginLeft: 2 }}>
      {forecastData.is_stale ? '⚠ Forecast stale' : `Forecast as of ${forecastData.as_of_date}`}
    </span>
  </div>
)}
```

Add a small inline note clarifying the flat-market assumption, without cluttering the existing badge:

```jsx
{activeIndicators.includes('forecast_lstm') && forecastData && (
  <div style={{marginBottom:'6px'}}>
    <span style={{ fontSize: '11px', color: forecastData.is_stale ? '#f59e0b' : '#9ca3af', marginLeft: 2 }}>
      {forecastData.is_stale ? '⚠ Forecast stale' : `Forecast as of ${forecastData.as_of_date}`}
    </span>
    <span
      title="Predicted price assumes the overall market (NIFTY) stays flat over the forecast window. The model predicts the stock's expected move relative to the market, not the market's own movement."
      style={{ fontSize: '10px', color: '#6b7280', marginLeft: 6, cursor: 'help', borderBottom: '1px dotted #6b7280' }}
    >
      ⓘ vs. flat market
    </span>
  </div>
)}
```

**Step 2: Manual verification**

Start the frontend dev server if not already running, log in, navigate to `/dashboard/charts?symbol=RELIANCE` (or any symbol with v2 forecast data from Task 3), enable the "AI Forecast (LSTM)" toggle, and confirm:
- The existing "Forecast as of [date]" badge still renders correctly.
- The new "ⓘ vs. flat market" note appears next to it.
- Hovering over the note shows the tooltip text explaining the assumption.

```bash
cd "/Users/srikrishnasingh/AG1 BB/PEESTOCKS/frontend" && npm run dev
```

---

### Task 6: End-to-end verification

**Step 1:** Confirm the API serves v2 data correctly for a real symbol:

```bash
cd "/Users/srikrishnasingh/AG1 BB/PEESTOCKS/backend" && source venv/bin/activate && PYTHONPATH=. python -c "
import httpx
r = httpx.post('http://localhost:8000/api/auth/login', json={'email':'admin@peestocks.com','password':'<the real admin password from earlier in this session>'})
token = r.json()['access_token']
r2 = httpx.get('http://localhost:8000/api/forecasts/RELIANCE', headers={'Authorization': f'Bearer {token}'})
print(r2.status_code, r2.json())
"
```
Expected: 200, `model_version: 'lstm-v2'`, 5 entries in `days` (not 10 — confirms v2's shorter horizon flowed through correctly), plausible prices.

**Step 2:** Confirm the AI Assistant's `forecast SYMBOL` intent still works (it queries the same `forecasts` table generically, so should need no code changes, but verify since this is the actual end-user-facing path):

In the running frontend, log in, go to `/dashboard/assistant`, type `forecast RELIANCE`, confirm a reply with a v2-backed forecast summary and a working chart link.

**Step 3:** Run the full backend test suite one more time to confirm the whole deployment is clean:

```bash
cd "/Users/srikrishnasingh/AG1 BB/PEESTOCKS/backend" && source venv/bin/activate
PYTHONPATH=. python test_forecast_service_v2.py
PYTHONPATH=. python test_lstm_model.py
PYTHONPATH=. python test_scans.py
PYTHONPATH=. python test_pattern_scan_upsert.py
```
Expected: all pass — confirms v2 deployment didn't regress any pre-existing functionality.
