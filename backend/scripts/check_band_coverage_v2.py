"""Supplementary check: does the v2 calibrated band actually achieve its target
coverage on real held-out data?

Reuses the already-trained backtest model (forecast_lstm_v2_backtest.pt, trained
excluding the last HOLDOUT_DAYS bars per instrument) and the calibrated
half-widths from the production model (forecast_lstm_v2.pt, Task 5) to check:
for each held-out prediction, does [predicted_relative_return - half_width,
predicted_relative_return + half_width] actually contain the real relative
return that occurred? Reported in relative-return space (where calibration was
computed), not price space.

Run directly: python scripts/check_band_coverage_v2.py
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
from app.services.forecast_service import compute_feature_frame, LOOKBACK, HORIZON_V2, N_FEATURES
from app.ml.lstm_model import ForecastLSTM, predict_mean

MAX_INSTRUMENTS = 200
HOLDOUT_DAYS = 40
NIFTY_INSTRUMENT_ID = 2222

BACKTEST_MODEL_PATH = os.path.normpath(os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "app", "ml", "forecast_lstm_v2_backtest.pt"
))
PRODUCTION_MODEL_PATH = os.path.normpath(os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "app", "ml", "forecast_lstm_v2.pt"
))


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

    model = ForecastLSTM(input_size=N_FEATURES, hidden_size=32, num_layers=2, horizon=HORIZON_V2)
    model.load_state_dict(torch.load(BACKTEST_MODEL_PATH, map_location="cpu"))

    prod = torch.load(PRODUCTION_MODEL_PATH, map_location="cpu")
    half_widths = prod["half_widths"]
    print(f"[coverage] using calibrated half-widths from production model: {half_widths}", flush=True)

    engine = _get_sync_engine()
    with Session(engine) as session:
        nifty_df = load_instrument_df(session, NIFTY_INSTRUMENT_ID)
        instruments = session.execute(
            select(Instrument).where(Instrument.is_active.is_(True))
        ).scalars().all()[:MAX_INSTRUMENTS]

        coverage_hits = {h: 0 for h in range(1, HORIZON_V2 + 1)}
        coverage_total = {h: 0 for h in range(1, HORIZON_V2 + 1)}

        n_inst_evaluated = 0
        for sidx, inst in enumerate(instruments, start=1):
            stock_df = load_instrument_df(session, inst.id)
            if stock_df is None:
                continue
            joined = stock_df.join(nifty_df[["close"]], rsuffix="_nifty", how="inner")
            n_total = len(joined)
            if n_total < LOOKBACK + HORIZON_V2 + HOLDOUT_DAYS + 20:
                continue
            train_len = n_total - HOLDOUT_DAYS

            stock_part = joined[["close", "high", "low", "volume"]]
            nifty_close_aligned = joined["close_nifty"]
            close_arr = stock_part["close"].to_numpy(dtype=np.float64)
            nifty_arr = nifty_close_aligned.to_numpy(dtype=np.float64)
            feat_arr = compute_feature_frame(stock_part).to_numpy(dtype=np.float64)

            anchor_start = max(LOOKBACK - 1, train_len)
            anchor_end = n_total - 1 - HORIZON_V2
            if anchor_end < anchor_start:
                continue

            any_eval = False
            for t in range(anchor_start, anchor_end + 1):
                window = feat_arr[t - LOOKBACK + 1: t + 1]
                if np.isnan(window).any():
                    continue
                mean_w = window.mean(axis=0)
                std_w = window.std(axis=0)
                std_w = np.where(std_w > 1e-8, std_w, 1.0)
                X_in = ((window - mean_w) / std_w).astype(np.float32).reshape(1, LOOKBACK, N_FEATURES)
                pred = predict_mean(model, torch.from_numpy(X_in))[0]

                stock_anchor = close_arr[t]
                nifty_anchor = nifty_arr[t]
                if stock_anchor <= 0 or nifty_anchor <= 0:
                    continue

                for h in range(1, HORIZON_V2 + 1):
                    future_idx = t + h
                    if future_idx >= n_total:
                        continue
                    actual_price = close_arr[future_idx]
                    actual_nifty = nifty_arr[future_idx]
                    if actual_price <= 0 or actual_nifty <= 0:
                        continue

                    actual_stock_ret = (actual_price - stock_anchor) / stock_anchor
                    actual_nifty_ret = (actual_nifty - nifty_anchor) / nifty_anchor
                    actual_relative_return = actual_stock_ret - actual_nifty_ret

                    predicted_relative_return = pred[h - 1]
                    hw = half_widths.get(h, half_widths.get(str(h), 0.0))

                    coverage_total[h] += 1
                    if (predicted_relative_return - hw) <= actual_relative_return <= (predicted_relative_return + hw):
                        coverage_hits[h] += 1
                    any_eval = True

            if any_eval:
                n_inst_evaluated += 1

            if sidx % 50 == 0 or sidx == len(instruments):
                print(f"[coverage] progress: {sidx}/{len(instruments)} instruments "
                      f"({n_inst_evaluated} evaluable so far)", flush=True)

        print("\n" + "=" * 70, flush=True)
        print("[coverage] RESULTS (target ~90% per horizon day)", flush=True)
        print("=" * 70, flush=True)
        total_hits = sum(coverage_hits.values())
        total_n = sum(coverage_total.values())
        for h in range(1, HORIZON_V2 + 1):
            pct = (coverage_hits[h] / coverage_total[h] * 100) if coverage_total[h] else float("nan")
            print(f"Day {h}: {coverage_hits[h]}/{coverage_total[h]} = {pct:.2f}%", flush=True)
        overall_pct = (total_hits / total_n * 100) if total_n else float("nan")
        print(f"\nOverall coverage: {total_hits}/{total_n} = {overall_pct:.2f}%", flush=True)
        print(f"[coverage] total wall time: {time.time() - t_start:.0f}s", flush=True)
        print("=" * 70, flush=True)


if __name__ == "__main__":
    main()
