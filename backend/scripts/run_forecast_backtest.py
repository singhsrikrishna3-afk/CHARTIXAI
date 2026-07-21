"""PEESTOCK — LSTM Forecast Backtest.

Genuine out-of-sample backtest of the LSTM forecast model:
  1. Holds out the last HOLDOUT_DAYS bars of each instrument's history.
  2. Trains a FRESH model on training-only data (everything before the holdout).
  3. Saves this model to a SEPARATE file (forecast_lstm_backtest.pt) — does
     NOT touch the production forecast_lstm.pt.
  4. Evaluates predictions made from points inside the holdout window against
     the REAL future closes that the model never saw during training.
  5. Reports MAPE (overall + per horizon day), band coverage, sample size,
     and a naive "tomorrow = today" baseline for comparison.

Run directly (not via Celery) — same convention as other one-off scripts in
backend/scripts/. No pytest, just print progress.
"""
import os
import sys
import time

sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import numpy as np
import torch
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.workers.tasks_eod import _get_sync_engine
from app.models.models import Instrument, OhlcvEod
from app.services.forecast_service import build_sequences, LOOKBACK, HORIZON
from app.ml.lstm_model import ForecastLSTM, train_one_epoch, predict_with_band

MAX_INSTRUMENTS = 200
HOLDOUT_DAYS = 40   # bars excluded from training, per instrument
EPOCHS = 5
BATCH_SIZE = 4096
LR = 0.001

BACKTEST_MODEL_PATH = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "app", "ml", "forecast_lstm_backtest.pt"
)
BACKTEST_MODEL_PATH = os.path.normpath(BACKTEST_MODEL_PATH)


def main():
    t_start = time.time()
    engine = _get_sync_engine()

    # ── Load per-instrument bar history, split into train / holdout ──
    all_X, all_y = [], []
    holdout_series = []  # list of (symbol, closes_full, volumes_full, train_len)

    with Session(engine) as session:
        instruments = session.execute(
            select(Instrument).where(Instrument.is_active.is_(True))
        ).scalars().all()
        instruments = instruments[:MAX_INSTRUMENTS]

        total_inst = len(instruments)
        print(f"[backtest] data prep: {total_inst} active instruments", flush=True)

        for idx, inst in enumerate(instruments, start=1):
            bars = session.execute(
                select(OhlcvEod)
                .where(OhlcvEod.instrument_id == inst.id)
                .order_by(OhlcvEod.time.asc())
            ).scalars().all()

            n = len(bars)
            # Need enough bars to both train (LOOKBACK+HORIZON minimum) and
            # have a genuine holdout region of HOLDOUT_DAYS bars excluded.
            if n < LOOKBACK + HORIZON + HOLDOUT_DAYS:
                continue

            train_len = n - HOLDOUT_DAYS
            train_bars = bars[:train_len]

            closes_train = [float(b.close) for b in train_bars]
            volumes_train = [float(b.volume or 0) for b in train_bars]

            if len(closes_train) >= LOOKBACK + HORIZON:
                X, y = build_sequences(closes_train, volumes_train)
                if len(X) > 0:
                    all_X.append(X)
                    all_y.append(y)

            closes_full = [float(b.close) for b in bars]
            volumes_full = [float(b.volume or 0) for b in bars]
            holdout_series.append((inst.symbol, closes_full, volumes_full, train_len))

            if idx % 50 == 0 or idx == total_inst:
                pct = idx / total_inst * 100
                print(f"[backtest] data prep progress: {idx}/{total_inst} ({pct:.1f}%)", flush=True)

    if not all_X:
        print("[backtest] No training data available; aborting.", flush=True)
        return

    X_train = torch.from_numpy(np.concatenate(all_X, axis=0))
    y_train = torch.from_numpy(np.concatenate(all_y, axis=0))
    print(f"[backtest] data prep done: {X_train.shape[0]} total training samples "
          f"(holdout-excluded last {HOLDOUT_DAYS} bars per instrument)", flush=True)

    # ── Train fresh model on training-only data ──
    model = ForecastLSTM(input_size=2, hidden_size=32, num_layers=2, horizon=HORIZON)
    optimizer = torch.optim.Adam(model.parameters(), lr=LR)

    n = X_train.shape[0]
    for epoch in range(EPOCHS):
        perm = torch.randperm(n)
        epoch_loss = 0.0
        n_batches = 0
        for start in range(0, n, BATCH_SIZE):
            idx = perm[start:start + BATCH_SIZE]
            loss = train_one_epoch(model, X_train[idx], y_train[idx], optimizer)
            epoch_loss += loss
            n_batches += 1
        avg_loss = epoch_loss / max(n_batches, 1)
        pct = (epoch + 1) / EPOCHS * 100
        elapsed = time.time() - t_start
        print(f"[backtest] epoch {epoch + 1}/{EPOCHS} ({pct:.0f}%) avg loss: {avg_loss:.6f} "
              f"elapsed: {elapsed:.0f}s", flush=True)

    os.makedirs(os.path.dirname(BACKTEST_MODEL_PATH), exist_ok=True)
    torch.save(model.state_dict(), BACKTEST_MODEL_PATH)
    print(f"[backtest] backtest model saved to {BACKTEST_MODEL_PATH} ({n} training samples)", flush=True)

    # ── Evaluation on held-out region ──
    print(f"[backtest] starting evaluation over {len(holdout_series)} instruments' holdout windows", flush=True)

    # Per-horizon-day accumulators
    ape_by_horizon = {h: [] for h in range(1, HORIZON + 1)}
    naive_ape_by_horizon = {h: [] for h in range(1, HORIZON + 1)}
    coverage_hits = 0
    coverage_total = 0

    model.eval()  # predict_with_band sets model.train() internally for MC-dropout, fine either way

    n_inst_evaluated = 0
    for sidx, (symbol, closes_full, volumes_full, train_len) in enumerate(holdout_series, start=1):
        n_total = len(closes_full)
        closes_arr = np.asarray(closes_full, dtype=np.float64)
        volumes_arr = np.asarray(volumes_full, dtype=np.float64)

        # Valid "as-of" indices: anchor day t such that:
        #   - we have LOOKBACK bars ending at t (t >= LOOKBACK - 1)
        #   - t is within the held-out region (t >= train_len, i.e. anchor itself
        #     was never used as a training target — its window may dip into the
        #     train region for history, which is fine/expected since LOOKBACK
        #     history naturally spans the train/holdout boundary at the start)
        #   - we have HORIZON real future closes after t (t + HORIZON <= n_total - 1)
        anchor_start = max(LOOKBACK - 1, train_len)
        anchor_end = n_total - 1 - HORIZON  # inclusive
        if anchor_end < anchor_start:
            continue

        any_eval = False
        for t in range(anchor_start, anchor_end + 1):
            window_closes = closes_arr[t - LOOKBACK + 1: t + 1]
            window_vols = volumes_arr[t - LOOKBACK + 1: t + 1]

            anchor_price = window_closes[-1]
            if anchor_price <= 0:
                continue
            vol_mean = window_vols.mean()
            vol_anchor = vol_mean if vol_mean > 0 else 1.0

            X = np.zeros((1, LOOKBACK, 2), dtype=np.float32)
            X[0, :, 0] = (window_closes - anchor_price) / anchor_price
            X[0, :, 1] = (window_vols - vol_anchor) / vol_anchor
            X_t = torch.from_numpy(X)

            mean, lower, upper = predict_with_band(model, X_t)
            mean, lower, upper = mean[0], lower[0], upper[0]

            future_actuals = closes_arr[t + 1: t + 1 + HORIZON]
            if len(future_actuals) < HORIZON:
                continue

            naive_guess = anchor_price  # "tomorrow = today" for every horizon day

            for h in range(1, HORIZON + 1):
                actual = future_actuals[h - 1]
                if actual <= 0:
                    continue
                pred_price = anchor_price * (1 + mean[h - 1])
                lower_price = anchor_price * (1 + lower[h - 1])
                upper_price = anchor_price * (1 + upper[h - 1])

                ape = abs(pred_price - actual) / actual * 100
                ape_by_horizon[h].append(ape)

                naive_ape = abs(naive_guess - actual) / actual * 100
                naive_ape_by_horizon[h].append(naive_ape)

                coverage_total += 1
                if lower_price <= actual <= upper_price:
                    coverage_hits += 1

                any_eval = True

        if any_eval:
            n_inst_evaluated += 1

        if sidx % 50 == 0 or sidx == len(holdout_series):
            print(f"[backtest] evaluation progress: {sidx}/{len(holdout_series)} instruments "
                  f"({n_inst_evaluated} with evaluable holdout points so far)", flush=True)

    # ── Aggregate & report ──
    all_ape = [v for h in ape_by_horizon.values() for v in h]
    all_naive_ape = [v for h in naive_ape_by_horizon.values() for v in h]

    print("\n" + "=" * 70, flush=True)
    print("[backtest] RESULTS", flush=True)
    print("=" * 70, flush=True)
    print(f"Instruments with evaluable holdout points: {n_inst_evaluated} / {len(holdout_series)}", flush=True)
    print(f"Total instrument-day-horizon predictions evaluated: {len(all_ape)}", flush=True)

    if not all_ape:
        print("[backtest] No evaluable predictions — holdout window likely too small. Aborting report.", flush=True)
        return

    print(f"\nOverall LSTM MAPE: {np.mean(all_ape):.3f}%", flush=True)
    print(f"Overall naive ('tomorrow = today') MAPE: {np.mean(all_naive_ape):.3f}%", flush=True)

    print("\nPer-horizon-day MAPE (LSTM vs naive baseline):", flush=True)
    print(f"{'Day':>5} {'n':>8} {'LSTM MAPE':>12} {'Naive MAPE':>12}", flush=True)
    for h in range(1, HORIZON + 1):
        n_h = len(ape_by_horizon[h])
        lstm_mape_h = np.mean(ape_by_horizon[h]) if n_h else float("nan")
        naive_mape_h = np.mean(naive_ape_by_horizon[h]) if n_h else float("nan")
        print(f"{h:>5} {n_h:>8} {lstm_mape_h:>11.3f}% {naive_mape_h:>11.3f}%", flush=True)

    coverage_pct = (coverage_hits / coverage_total * 100) if coverage_total else float("nan")
    print(f"\nBand coverage (actual within [5th,95th] MC-dropout band): "
          f"{coverage_hits}/{coverage_total} = {coverage_pct:.2f}%", flush=True)
    print("(Target for a well-calibrated ~90% interval: close to 90%.)", flush=True)

    elapsed = time.time() - t_start
    print(f"\n[backtest] total wall time: {elapsed:.0f}s", flush=True)
    print("=" * 70, flush=True)


if __name__ == "__main__":
    main()
