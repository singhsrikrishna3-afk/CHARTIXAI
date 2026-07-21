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
