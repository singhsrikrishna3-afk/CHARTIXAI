# Deploy v2 LSTM Forecast to Production — Design

## Why
v2 was validated via honest backtest: beats naive baseline at all 5 horizon days (2.574% vs 2.769% overall MAPE) and has well-calibrated confidence bands (90.07% coverage vs 90% target), on 200 stocks. v1 (live in production) failed both checks. This design deploys v2 to fully replace v1.

## 1. Live price conversion
v2 predicts NIFTY-relative excess return ("alpha"), not absolute price. At live-forecast time, future NIFTY return is unknown (only knowable in backtest, using historical fact). Convert for display as:

```
predicted_price = anchor_price * (1 + predicted_alpha)
```

This assumes NIFTY stays flat over the forecast window — an explicit, documented simplification, not a claim that NIFTY itself is being forecast. Surface this assumption in the UI (e.g. a tooltip near the forecast badge: "assumes flat market").

## 2. Vectorize `build_relative_sequences`
Current implementation (`backend/app/services/forecast_service.py`) uses a per-sample Python loop — fine at 200 stocks (~3.5 min data prep) but would scale to 30-45+ min at 2,281 stocks. Rewrite using `numpy.lib.stride_tricks.sliding_window_view`, matching the vectorization technique v1's `build_sequences` already used, while preserving correct per-window z-score normalization (vectorized rolling mean/std instead of per-window Python computation). Must produce numerically identical results to the current implementation — validate via the existing test suite (`test_forecast_service_v2.py`) plus a direct numerical comparison against the current loop-based version on real data before considering it done.

## 3. Full production retrain
One-time retrain on all 2,281 active instruments (not the 200-stock validation scope), run after vectorization lands. Going forward, reuses v1's existing weekly (`retrain_forecast_model`, Saturdays 8pm) / nightly (`precompute_forecasts`, 7:30pm) Celery beat schedule — no schedule changes needed.

## 4. Drop-in replacement — no schema/API/UI changes
The `forecasts` table, `GET /api/forecasts/{symbol}` endpoint, chart overlay (`dashboard/charts`), and AI Assistant `forecast SYMBOL` intent are all already generic — none hardcode v1-specific logic, horizon count, or feature shape. Swap `tasks_forecast.py`'s `precompute_forecasts` and `retrain_forecast_model` function bodies to call v2's feature engineering / model code, write `model_version="lstm-v2"` into the existing column. `HORIZON_V2=5` (vs. v1's 10) just means 5 rows get written/returned per instrument instead of 10 — nothing downstream assumes a fixed count, confirmed during v1 build.

## 5. Cleanup
Since v1 is fully retired (not kept as fallback), remove its now-dead code: `build_sequences`, `predict_with_band`, v1's `MODEL_PATH` and saved model file (`forecast_lstm.pt`), v1's `LOOKBACK`/`HORIZON` constants if no longer referenced anywhere. v2's validation scripts (`train_forecast_v2.py`, `run_forecast_backtest_v2.py`, `check_band_coverage_v2.py`) stay as standalone scripts in `backend/scripts/` for future re-validation, not deleted.

## Out of scope
- Per-sector/volatility-bucket models (deferred from the original v2 design)
- Quantile-loss training (empirical calibration already validated as sufficient)
- A v1 fallback path (explicitly rejected — full replacement chosen)
