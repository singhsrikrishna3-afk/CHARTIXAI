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

    # Indicator warm-up (SMA-20/BBands-20/rel-volume-20) needs ~19 extra prior
    # bars beyond the LOOKBACK window itself, or the tail of the feature frame
    # still contains NaNs. Fetch generously past that minimum.
    FETCH_LIMIT = LOOKBACK + 40

    engine = _get_sync_engine()
    with Session(engine) as session:
        nifty_df = _load_instrument_df(session, NIFTY_INSTRUMENT_ID, limit=FETCH_LIMIT)
        if nifty_df is None:
            logger.error("NIFTY_50 (id=%s) has no data; aborting precompute.", NIFTY_INSTRUMENT_ID)
            return {"written": 0, "skipped": 0, "error": "no nifty data"}

        instruments = session.execute(
            select(Instrument).where(Instrument.is_active.is_(True))
        ).scalars().all()

        total_inst = len(instruments)
        print(f"[precompute] {total_inst} active instruments", flush=True)
        for idx, inst in enumerate(instruments, start=1):
            stock_df = _load_instrument_df(session, inst.id, limit=FETCH_LIMIT)
            if stock_df is None:
                skipped += 1
                continue

            joined = stock_df.join(nifty_df[["close"]], rsuffix="_nifty", how="inner")
            if len(joined) < LOOKBACK:
                skipped += 1
                continue

            stock_part = joined[["close", "high", "low", "volume"]]
            feat_full = compute_feature_frame(stock_part)
            feat = feat_full.iloc[-LOOKBACK:]
            stock_part = stock_part.iloc[-LOOKBACK:]
            if feat.isna().any().any():
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
