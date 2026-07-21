# LSTM Forecast Redesign v2 — Design

## Why
The v1 LSTM forecast model (price+volume only, 10-day horizon, absolute price target) was honestly backtested: 57,900 out-of-sample predictions, LSTM MAPE 3.649% vs. naive "tomorrow=today" baseline 3.558%. The model did not beat the naive baseline at any horizon day, and its MC-dropout confidence band achieved only 5.09% empirical coverage against a ~90% target. v1 is not predictive and its bands are not honest.

## Goal
Redesign the model to (a) give it a realistic chance of beating the naive baseline by feeding it real predictive signal instead of raw price, and (b) make its confidence bands empirically honest. Validate with the same backtest methodology that exposed v1's problems.

## Scope for this pass
- Pooled model (no per-sector/volatility segmentation — deferred)
- 200 stocks (same as v1, for speed — full 2,281-stock training deferred)
- 5-day forecast horizon (down from 10)
- Success bar: LSTM MAPE beats naive baseline MAPE overall, any margin

## 1. Feature engineering
Replace the `(close, volume)` per-timestep input with a richer feature vector computed via existing `backend/app/services/scanner_engine.py` functions (no new indicator math):
- RSI(14)
- MACD histogram
- % distance from 20-day SMA
- Bollinger Band %B (position within bands)
- Relative volume (today's volume ÷ 20-day average volume)
- Daily return

`LOOKBACK` stays 60 days. `HORIZON` changes 10 → 5.

## 2. Relative-return target
Training target changes from "future absolute close" to "future cumulative return minus NIFTY_50's cumulative return over the same window" (predicting alpha vs. the market, not raw price). NIFTY_50 (instrument id 2222, confirmed present with real OHLCV history) provides the benchmark series, joined by date against each stock.

## 3. Band calibration
Drop raw MC-dropout percentile bands (proven badly miscalibrated in v1). After training, evaluate the model against a calibration slice (the 40 days immediately before the final holdout window — distinct from both train and holdout) and compute the empirical residual distribution per horizon day. Scale band width using that empirical distribution so it targets ~90% real coverage, rather than trusting raw MC-dropout variance.

## 4. Validation
Reuse `backend/scripts/run_forecast_backtest.py`'s train/holdout split and naive-baseline comparison logic, adapted for: new feature pipeline, 5-day horizon, and un-transforming predicted alpha back to absolute price (using the real NIFTY return over the matching window) so MAPE stays comparable in price terms to v1's reported numbers.

## Explicitly deferred (not this pass)
- Per-sector / per-volatility-bucket models
- Quantile-loss training (using empirical calibration instead)
- Full 2,281-stock training
