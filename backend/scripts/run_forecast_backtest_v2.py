"""PEESTOCK — LSTM Forecast v2 Backtest.

Same honest train/holdout methodology as run_forecast_backtest.py (v1), adapted
for v2's feature engineering and NIFTY-relative return target. Trains a model
on data BEFORE a holdout window, evaluates on real future prices the model
never saw, compares against a naive "tomorrow=today" baseline in absolute-price
MAPE terms (un-transforming v2's relative-return predictions using the ACTUAL
realized NIFTY return over the matching window — fair to do in a backtest since
we know history; this is NOT something the live precompute path could do, since
future NIFTY return is unknown at prediction time).

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
                    if actual_price <= 0 or actual_nifty <= 0 or np.isnan(actual_price) or np.isnan(actual_nifty):
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
