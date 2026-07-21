# LSTM Price Forecast Feature — Design

## Goal
Build a real predictive forecasting feature to match the README's "LSTM AI Forecasting" claim. Currently the AI Assistant is rule-based NL-to-query only — no prediction exists anywhere in the product.

## Approach
Pooled LSTM (PyTorch) trained across all tracked symbols, with forecasts precomputed nightly via Celery and read instantly by the UI (no live inference latency).

## 1. Data pipeline & model (backend)
- `backend/app/services/forecast_service.py` — builds training sequences from historical OHLCV data: normalized close/volume windows (60-day lookback → 10-day forecast horizon), pooled across all symbols with a per-symbol/sector feature so the model differentiates behavior.
- `backend/app/ml/lstm_model.py` — PyTorch LSTM (2-3 layers), trained with quantile loss (or MC-dropout at inference) to produce both a predicted price path and a confidence band, not just a point estimate.
- Add `torch` (CPU-only build compatible with Python 3.9) to `requirements.txt`.

## 2. Training & batch inference (Celery)
- `backend/app/workers/tasks_forecast.py`:
  - `retrain_forecast_model` — runs weekly.
  - `precompute_forecasts` — runs daily after EOD sync completes; generates a 10-day forecast per symbol, writes to a new `forecasts` table: `symbol, as_of_date, horizon_day, predicted_close, lower_band, upper_band`.
- Backtesting: before a retrained model replaces the live one, a validation job computes historical accuracy (MAPE, % of actuals within predicted band) on a held-out time period and logs it. Surfaced in UI as a trust signal.

## 3. API
- `GET /api/forecast/{symbol}` — returns latest precomputed forecast rows (predicted path + band + `as_of_date` + model accuracy metric).

## 4. UI — Chart page (`dashboard/charts`)
- "Forecast" toggle near existing timeframe/indicator buttons.
- When enabled: extends the chart series past the last real candle with a dashed predicted-price line and shaded confidence band (same visual language as Bollinger Bands).
- Badge near toggle: "Model accuracy: NN% (90d)" pulled from the backtest metric.

## 5. UI — AI Assistant
- Extend intent parsing to recognize "forecast SYMBOL" / "predict SYMBOL" queries, calling `/api/forecast/{symbol}`.
- Renders a compact inline mini-chart (sparkline-style) with the forecast path + band, plus a "View full chart →" link to `/dashboard/charts?symbol=X&forecast=1`. Keeps the existing "no LLM hallucinations" framing — this is a real data lookup, not a generated claim.

## 6. Error handling & edge cases
- New/recently-listed symbols with <60 days of history → endpoint returns `"insufficient_history"`; UI shows "Not enough data yet."
- Stale forecasts (precompute job failed) → endpoint includes `as_of_date`; UI shows a "stale" warning badge if more than 1 trading day old.

## 7. Testing
- Unit tests for sequence-building (correct windowing, normalization).
- Smoke test: a tiny dummy LSTM can train/infer without error.
- Ongoing: weekly backtest validation job itself acts as a regression test for model quality over time.
