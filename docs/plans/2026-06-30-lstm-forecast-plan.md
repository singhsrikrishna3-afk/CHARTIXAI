# LSTM Price Forecast Feature Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a real LSTM-based price forecast feature — precomputed nightly per symbol, exposed via API, and rendered on the chart page and AI Assistant — to back the README's "LSTM AI Forecasting" claim.

**Architecture:** A pooled PyTorch LSTM trained across all symbols in `ohlcv_eod`, producing a 10-day forward price path + confidence band. A Celery task precomputes forecasts nightly after EOD sync and stores them in a new `forecasts` table (created via `Base.metadata.create_all`, matching the existing `PatternBacktestStat` ad-hoc table pattern — this project does not use Alembic migrations for new tables). A new `GET /api/forecasts/{symbol}` endpoint serves the latest precomputed rows. Frontend reads via a new `api.getForecast()` call, renders a dashed forecast line + shaded band on the Lightweight Charts instance, and the AI Assistant gets a new intent ("forecast SYMBOL").

**Tech Stack:** PyTorch (CPU, torch==2.2.2 — last version with broad Python 3.9 wheel support), existing Celery/Redis, existing FastAPI + SQLAlchemy async ORM, existing Lightweight Charts v5 frontend.

**Canonical project tree:** `backend/` and `frontend/` at repo root (confirmed via `docker-compose.yml` build contexts). Do NOT touch `peestock/backend` or `peestock/frontend` — that's a stale duplicate.

---

### Task 0: Add PyTorch dependency

**Files:**
- Modify: `backend/requirements.txt`

**Step 1:** Add this line after `numpy==2.1.0`:
```
torch==2.2.2
```

**Step 2:** Install into the venv.

Run:
```bash
cd "/Users/srikrishnasingh/AG1 BB/PEESTOCKS/backend" && source venv/bin/activate && pip install torch==2.2.2
```
Expected: installs successfully (CPU wheel). If it fails due to Python 3.9 incompatibility, fall back to `torch==2.2.0` or check `pip index versions torch` for the newest 3.9-compatible release.

**Step 3:** Verify import works.

Run: `python -c "import torch; print(torch.__version__)"`
Expected: prints `2.2.2` (or whichever version installed) with no error.

**Step 4: Commit**

This project is not a git repo — skip commit steps throughout this plan. Instead, note progress in your own tracking (e.g. TaskUpdate) after each task.

---

### Task 1: `forecasts` table model

**Files:**
- Modify: `backend/app/models/models.py`

**Step 1:** Add a new model near `PatternBacktestStat` (or other recent models), matching existing style (check exact column types used for `OhlcvEod` — `Numeric(12, 2)` for prices):

```python
class Forecast(Base):
    __tablename__ = "forecasts"

    id = Column(Integer, primary_key=True, autoincrement=True)
    instrument_id = Column(Integer, ForeignKey("instruments.id"), nullable=False, index=True)
    as_of_date = Column(Date, nullable=False, index=True)
    horizon_day = Column(Integer, nullable=False)  # 1..10
    predicted_close = Column(Numeric(12, 2), nullable=False)
    lower_band = Column(Numeric(12, 2), nullable=False)
    upper_band = Column(Numeric(12, 2), nullable=False)
    model_version = Column(String(40), nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        Index("idx_forecasts_instr_asof", "instrument_id", "as_of_date"),
    )
```

Confirm `Date`, `DateTime`, `Numeric`, `Index`, `func` are already imported at the top of `models.py` (they should be, since `OhlcvEod` and other models use them) — if any import is missing, add it to the existing `from sqlalchemy import ...` line rather than adding a new import line.

**Step 2:** Create the table in the running SQLite DB, matching the ad-hoc pattern used for `PatternBacktestStat` in `tasks_eod.py`.

Run a one-off Python snippet:
```bash
cd "/Users/srikrishnasingh/AG1 BB/PEESTOCKS/backend" && source venv/bin/activate && PYTHONPATH=. python -c "
from sqlalchemy import create_engine
from app.models.models import Base, Forecast
from app.config import get_settings
settings = get_settings()
url = settings.DATABASE_URL.replace('+aiosqlite', '').replace('+asyncpg', '')
engine = create_engine(url)
Base.metadata.create_all(engine, tables=[Forecast.__table__], checkfirst=True)
print('forecasts table created')
"
```
Expected: prints `forecasts table created` with no error.

**Step 3:** Verify the table exists.

Run: `sqlite3 "/Users/srikrishnasingh/AG1 BB/PEESTOCKS/peestock.db" ".schema forecasts"`
Expected: shows the `CREATE TABLE forecasts (...)` statement with all columns from Step 1.

---

### Task 2: Sequence-building service (TDD)

**Files:**
- Create: `backend/app/services/forecast_service.py`
- Test: `backend/test_forecast_service.py`

**Step 1: Write the failing test**

Follow the project's existing lightweight test convention (no pytest — see `test_pattern_scan_upsert.py`): plain script, manual assertions, `SystemExit(1)` on failure.

```python
"""Test forecast_service sequence building.
Run directly: python test_forecast_service.py
"""
import numpy as np
from app.services.forecast_service import build_sequences, LOOKBACK, HORIZON

failures = []

def check(label, condition):
    if not condition:
        failures.append(label)
        print(f"FAIL: {label}")
    else:
        print(f"PASS: {label}")

# Build a fake close-price series: 100 days, linearly increasing
closes = [100.0 + i * 0.5 for i in range(100)]
volumes = [1_000_000 for _ in range(100)]

X, y = build_sequences(closes, volumes)

check("X has correct number of samples", len(X) == 100 - LOOKBACK - HORIZON + 1)
check("each X window has LOOKBACK rows", X.shape[1] == LOOKBACK)
check("each X row has 2 features (close, volume)", X.shape[2] == 2)
check("y has HORIZON target values per sample", y.shape[1] == HORIZON)
check("X is normalized (values roughly in [-5, 5])", np.abs(X).max() < 10)

# Too-short series should raise or return empty
short_closes = [100.0] * 10
short_volumes = [1000] * 10
X_short, y_short = build_sequences(short_closes, short_volumes)
check("short series returns empty arrays", len(X_short) == 0 and len(y_short) == 0)

if failures:
    print(f"\n{len(failures)} check(s) failed: {failures}")
    raise SystemExit(1)
print("\nAll checks passed.")
```

**Step 2: Run test to verify it fails**

Run: `cd "/Users/srikrishnasingh/AG1 BB/PEESTOCKS/backend" && source venv/bin/activate && PYTHONPATH=. python test_forecast_service.py`
Expected: `ModuleNotFoundError: No module named 'app.services.forecast_service'`

**Step 3: Write minimal implementation**

```python
"""Builds normalized training sequences from OHLCV history for the LSTM forecast model."""
import numpy as np

LOOKBACK = 60   # days of history per input window
HORIZON = 10    # days to forecast forward


def build_sequences(closes, volumes):
    """Given parallel lists of daily close prices and volumes (chronological order),
    return (X, y) where X is shape (n_samples, LOOKBACK, 2) normalized per-window,
    and y is shape (n_samples, HORIZON) of normalized future close prices.

    Returns empty arrays if there isn't enough history for at least one sample.
    """
    n = len(closes)
    min_required = LOOKBACK + HORIZON
    if n < min_required:
        return np.empty((0, LOOKBACK, 2)), np.empty((0, HORIZON))

    closes = np.asarray(closes, dtype=np.float64)
    volumes = np.asarray(volumes, dtype=np.float64)

    n_samples = n - min_required + 1
    X = np.zeros((n_samples, LOOKBACK, 2), dtype=np.float32)
    y = np.zeros((n_samples, HORIZON), dtype=np.float32)

    for i in range(n_samples):
        window_close = closes[i:i + LOOKBACK]
        window_vol = volumes[i:i + LOOKBACK]
        future_close = closes[i + LOOKBACK:i + LOOKBACK + HORIZON]

        # Normalize within-window: percent change from the window's last close
        anchor = window_close[-1]
        norm_close = (window_close - anchor) / anchor
        vol_anchor = window_vol.mean() if window_vol.mean() > 0 else 1.0
        norm_vol = (window_vol - vol_anchor) / vol_anchor
        norm_future = (future_close - anchor) / anchor

        X[i, :, 0] = norm_close
        X[i, :, 1] = norm_vol
        y[i, :] = norm_future

    return X, y
```

**Step 4: Run test to verify it passes**

Run: `cd "/Users/srikrishnasingh/AG1 BB/PEESTOCKS/backend" && source venv/bin/activate && PYTHONPATH=. python test_forecast_service.py`
Expected: `All checks passed.`

---

### Task 3: LSTM model definition (TDD smoke test)

**Files:**
- Create: `backend/app/ml/__init__.py` (empty)
- Create: `backend/app/ml/lstm_model.py`
- Test: `backend/test_lstm_model.py`

**Step 1: Write the failing test**

```python
"""Smoke test: tiny LSTM model can train one step and infer without error.
Run directly: python test_lstm_model.py
"""
import numpy as np
import torch
from app.ml.lstm_model import ForecastLSTM, train_one_epoch

failures = []

def check(label, condition):
    if not condition:
        failures.append(label)
        print(f"FAIL: {label}")
    else:
        print(f"PASS: {label}")

torch.manual_seed(0)

model = ForecastLSTM(input_size=2, hidden_size=8, horizon=10)
X = torch.randn(16, 60, 2)  # batch=16, lookback=60, features=2
y = torch.randn(16, 10)     # batch=16, horizon=10

# Forward pass shape check
out = model(X)
check("output shape matches (batch, horizon)", tuple(out.shape) == (16, 10))

# One training step should reduce loss (or at least run without error)
optimizer = torch.optim.Adam(model.parameters(), lr=0.01)
loss_before = train_one_epoch(model, X, y, optimizer)
loss_after = train_one_epoch(model, X, y, optimizer)
check("loss is a finite float", np.isfinite(loss_before) and np.isfinite(loss_after))
check("training reduces loss on repeated same-batch fitting", loss_after < loss_before)

if failures:
    print(f"\n{len(failures)} check(s) failed: {failures}")
    raise SystemExit(1)
print("\nAll checks passed.")
```

**Step 2: Run test to verify it fails**

Run: `cd "/Users/srikrishnasingh/AG1 BB/PEESTOCKS/backend" && source venv/bin/activate && PYTHONPATH=. python test_lstm_model.py`
Expected: `ModuleNotFoundError: No module named 'app.ml'`

**Step 3: Write minimal implementation**

```python
"""LSTM model for multi-day price forecasting with quantile (band) outputs."""
import torch
import torch.nn as nn


class ForecastLSTM(nn.Module):
    def __init__(self, input_size=2, hidden_size=32, num_layers=2, horizon=10, dropout=0.2):
        super().__init__()
        self.lstm = nn.LSTM(
            input_size=input_size,
            hidden_size=hidden_size,
            num_layers=num_layers,
            batch_first=True,
            dropout=dropout if num_layers > 1 else 0.0,
        )
        self.head = nn.Linear(hidden_size, horizon)

    def forward(self, x):
        # x: (batch, lookback, features)
        out, (h_n, _) = self.lstm(x)
        last_hidden = h_n[-1]  # (batch, hidden_size)
        return self.head(last_hidden)  # (batch, horizon)


def train_one_epoch(model, X, y, optimizer):
    model.train()
    optimizer.zero_grad()
    pred = model(X)
    loss = nn.functional.mse_loss(pred, y)
    loss.backward()
    optimizer.step()
    return loss.item()


def predict_with_band(model, X, n_samples=20):
    """Monte-Carlo dropout inference: run forward pass n_samples times with
    dropout active to get a distribution of predictions per horizon day.
    Returns (mean, lower_5pct, upper_95pct), each shape (batch, horizon).
    """
    model.train()  # keep dropout active
    preds = []
    with torch.no_grad():
        for _ in range(n_samples):
            preds.append(model(X).numpy())
    import numpy as np
    stacked = np.stack(preds, axis=0)  # (n_samples, batch, horizon)
    mean = stacked.mean(axis=0)
    lower = np.percentile(stacked, 5, axis=0)
    upper = np.percentile(stacked, 95, axis=0)
    return mean, lower, upper
```

**Step 4: Run test to verify it passes**

Run: `cd "/Users/srikrishnasingh/AG1 BB/PEESTOCKS/backend" && source venv/bin/activate && PYTHONPATH=. python test_lstm_model.py`
Expected: `All checks passed.`

---

### Task 4: Celery task — precompute forecasts

**Files:**
- Create: `backend/app/workers/tasks_forecast.py`
- Modify: `backend/app/workers/celery_app.py`

**Step 1:** Write the task, following the exact sync-engine pattern from `tasks_eod.py`:

```python
"""Celery tasks for LSTM price forecasting: training and batch inference."""
import logging
from datetime import date, timedelta

import numpy as np
import torch
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.workers.celery_app import celery_app
from app.workers.tasks_eod import _get_sync_engine
from app.models.models import Instrument, OhlcvEod, Forecast
from app.services.forecast_service import build_sequences, LOOKBACK, HORIZON
from app.ml.lstm_model import ForecastLSTM, predict_with_band

logger = logging.getLogger(__name__)

MODEL_VERSION = "lstm-v1"
MODEL_PATH = "backend/app/ml/forecast_lstm.pt"


@celery_app.task(name="app.workers.tasks_forecast.precompute_forecasts")
def precompute_forecasts():
    engine = _get_sync_engine()
    today = date.today()
    written = 0
    skipped = 0

    model = ForecastLSTM(input_size=2, hidden_size=32, num_layers=2, horizon=HORIZON)
    try:
        model.load_state_dict(torch.load(MODEL_PATH, map_location="cpu"))
    except FileNotFoundError:
        logger.warning("No trained model found at %s; skipping precompute. Run retrain_forecast_model first.", MODEL_PATH)
        return {"written": 0, "skipped": 0, "error": "model not found"}

    with Session(engine) as session:
        instruments = session.execute(
            select(Instrument).where(Instrument.is_active.is_(True))
        ).scalars().all()

        for inst in instruments:
            bars = session.execute(
                select(OhlcvEod)
                .where(OhlcvEod.instrument_id == inst.id)
                .order_by(OhlcvEod.time.desc())
                .limit(LOOKBACK + 5)
            ).scalars().all()
            bars = list(reversed(bars))

            if len(bars) < LOOKBACK:
                skipped += 1
                continue

            closes = [float(b.close) for b in bars[-LOOKBACK:]]
            volumes = [float(b.volume or 0) for b in bars[-LOOKBACK:]]
            anchor = closes[-1]
            vol_anchor = (sum(volumes) / len(volumes)) or 1.0

            X = np.zeros((1, LOOKBACK, 2), dtype=np.float32)
            X[0, :, 0] = [(c - anchor) / anchor for c in closes]
            X[0, :, 1] = [(v - vol_anchor) / vol_anchor for v in volumes]
            X_t = torch.from_numpy(X)

            mean, lower, upper = predict_with_band(model, X_t)
            mean, lower, upper = mean[0], lower[0], upper[0]

            session.query(Forecast).filter(
                Forecast.instrument_id == inst.id,
                Forecast.as_of_date == today,
            ).delete()

            for day_idx in range(HORIZON):
                pred_price = anchor * (1 + mean[day_idx])
                lower_price = anchor * (1 + lower[day_idx])
                upper_price = anchor * (1 + upper[day_idx])
                session.add(Forecast(
                    instrument_id=inst.id,
                    as_of_date=today,
                    horizon_day=day_idx + 1,
                    predicted_close=round(float(pred_price), 2),
                    lower_band=round(float(lower_price), 2),
                    upper_band=round(float(upper_price), 2),
                    model_version=MODEL_VERSION,
                ))
            written += 1

        session.commit()

    logger.info("Forecast precompute done: %d written, %d skipped", written, skipped)
    return {"written": written, "skipped": skipped}


@celery_app.task(name="app.workers.tasks_forecast.retrain_forecast_model")
def retrain_forecast_model():
    engine = _get_sync_engine()
    all_X, all_y = [], []

    with Session(engine) as session:
        instruments = session.execute(
            select(Instrument).where(Instrument.is_active.is_(True))
        ).scalars().all()

        for inst in instruments:
            bars = session.execute(
                select(OhlcvEod)
                .where(OhlcvEod.instrument_id == inst.id)
                .order_by(OhlcvEod.time.asc())
            ).scalars().all()

            if len(bars) < LOOKBACK + HORIZON:
                continue

            closes = [float(b.close) for b in bars]
            volumes = [float(b.volume or 0) for b in bars]
            X, y = build_sequences(closes, volumes)
            if len(X) > 0:
                all_X.append(X)
                all_y.append(y)

    if not all_X:
        logger.warning("No training data available; aborting retrain.")
        return {"trained": False, "reason": "no data"}

    X_train = torch.from_numpy(np.concatenate(all_X, axis=0))
    y_train = torch.from_numpy(np.concatenate(all_y, axis=0))

    model = ForecastLSTM(input_size=2, hidden_size=32, num_layers=2, horizon=HORIZON)
    optimizer = torch.optim.Adam(model.parameters(), lr=0.001)

    from app.ml.lstm_model import train_one_epoch
    batch_size = 256
    n = X_train.shape[0]
    epochs = 10
    for epoch in range(epochs):
        perm = torch.randperm(n)
        epoch_loss = 0.0
        n_batches = 0
        for start in range(0, n, batch_size):
            idx = perm[start:start + batch_size]
            loss = train_one_epoch(model, X_train[idx], y_train[idx], optimizer)
            epoch_loss += loss
            n_batches += 1
        logger.info("Epoch %d/%d avg loss: %.6f", epoch + 1, epochs, epoch_loss / max(n_batches, 1))

    torch.save(model.state_dict(), MODEL_PATH)
    logger.info("Model saved to %s (%d training samples)", MODEL_PATH, n)
    return {"trained": True, "samples": n}
```

**Step 2:** Register the new task module and add beat schedule entries.

In `backend/app/workers/celery_app.py`, modify:
```python
include=["app.workers.tasks_eod", "app.workers.tasks_intraday"],
```
to:
```python
include=["app.workers.tasks_eod", "app.workers.tasks_intraday", "app.workers.tasks_forecast"],
```

And add to `beat_schedule`:
```python
"forecast-weekly-retrain": {
    "task": "app.workers.tasks_forecast.retrain_forecast_model",
    "schedule": crontab(hour=20, minute=0, day_of_week=6),
},
"forecast-daily-precompute": {
    "task": "app.workers.tasks_forecast.precompute_forecasts",
    "schedule": crontab(hour=19, minute=30),
},
```
(19:30 is after the existing `eod-data-update` at 18:30, so EOD data is fresh before forecasts run.)

**Step 3:** Verify the task runs end-to-end manually (synchronous call, no Celery worker needed for this check).

Run:
```bash
cd "/Users/srikrishnasingh/AG1 BB/PEESTOCKS/backend" && source venv/bin/activate && PYTHONPATH=. python -c "
from app.workers.tasks_forecast import retrain_forecast_model, precompute_forecasts
print(retrain_forecast_model())
print(precompute_forecasts())
"
```
Expected: first call prints `{'trained': True, 'samples': N}` with N > 0 (assuming `peestock.db` has enough historical bars per symbol), second call prints `{'written': M, 'skipped': K}` with M > 0.

If `'trained': False, 'reason': 'no data'` — there isn't enough historical data per symbol (need 70+ daily bars). Check actual bar counts before proceeding:
```bash
sqlite3 "/Users/srikrishnasingh/AG1 BB/PEESTOCKS/peestock.db" "SELECT instrument_id, COUNT(*) FROM ohlcv_eod GROUP BY instrument_id ORDER BY COUNT(*) DESC LIMIT 5;"
```

---

### Task 5: Pydantic schema for forecast response

**Files:**
- Modify: `backend/app/schemas/schemas.py`

**Step 1:** Add, matching the existing `from_attributes = True` convention:

```python
class ForecastDay(BaseModel):
    horizon_day: int
    predicted_close: float
    lower_band: float
    upper_band: float

    class Config:
        from_attributes = True


class ForecastOut(BaseModel):
    symbol: str
    as_of_date: date
    model_version: str
    is_stale: bool
    days: list[ForecastDay]
```

**Step 2:** No test needed for a pure data schema — verified implicitly by the endpoint test in Task 6.

---

### Task 6: API endpoint `GET /api/forecasts/{symbol}`

**Files:**
- Create: `backend/app/api/forecasts.py`
- Modify: `backend/app/main.py`
- Test: `backend/test_forecasts_api.py`

**Step 1:** Write the endpoint, matching the exact pattern from `app/api/instruments.py`:

```python
import logging
from datetime import date, timedelta

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models.models import Instrument, Forecast
from app.schemas.schemas import ForecastOut, ForecastDay
from app.auth import get_current_user

router = APIRouter(prefix="/api/forecasts", tags=["forecasts"])
logger = logging.getLogger(__name__)


@router.get("/{symbol}", response_model=ForecastOut)
async def get_forecast(
    symbol: str,
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    inst = await db.execute(select(Instrument).where(Instrument.symbol == symbol.upper()))
    instrument = inst.scalar_one_or_none()
    if not instrument:
        raise HTTPException(status_code=404, detail="Symbol not found")

    latest_date_q = await db.execute(
        select(Forecast.as_of_date)
        .where(Forecast.instrument_id == instrument.id)
        .order_by(Forecast.as_of_date.desc())
        .limit(1)
    )
    latest_date = latest_date_q.scalar_one_or_none()
    if latest_date is None:
        raise HTTPException(status_code=404, detail="insufficient_history")

    rows_q = await db.execute(
        select(Forecast)
        .where(Forecast.instrument_id == instrument.id, Forecast.as_of_date == latest_date)
        .order_by(Forecast.horizon_day.asc())
    )
    rows = rows_q.scalars().all()

    is_stale = (date.today() - latest_date) > timedelta(days=1)

    return ForecastOut(
        symbol=instrument.symbol,
        as_of_date=latest_date,
        model_version=rows[0].model_version if rows else "unknown",
        is_stale=is_stale,
        days=[
            ForecastDay(
                horizon_day=r.horizon_day,
                predicted_close=float(r.predicted_close),
                lower_band=float(r.lower_band),
                upper_band=float(r.upper_band),
            )
            for r in rows
        ],
    )
```

**Step 2:** Register the router in `backend/app/main.py` — add near the other `include_router` calls (after `app.include_router(alerts_router)` or in the same alphabetic/logical grouping):

```python
app.include_router(forecasts_router)
```
And add the corresponding import at the top of `main.py` alongside the other router imports (find the existing import block, e.g. `from app.api.alerts import router as alerts_router`, and add `from app.api.forecasts import router as forecasts_router`).

**Step 3:** Write a standalone test matching the `test_pattern_scan_upsert.py` style — spin up FastAPI's `TestClient` against the real (already-seeded) `peestock.db` rather than building a fresh SQLite schema, since this only reads:

```python
"""Test GET /api/forecasts/{symbol} endpoint.
Run directly: python test_forecasts_api.py
Requires: peestock.db already has forecasts (run tasks_forecast.precompute_forecasts first).
"""
from fastapi.testclient import TestClient
from app.main import app
from app.workers.tasks_forecast import precompute_forecasts, retrain_forecast_model

failures = []

def check(label, condition):
    if not condition:
        failures.append(label)
        print(f"FAIL: {label}")
    else:
        print(f"PASS: {label}")

# Ensure at least one forecast exists
retrain_forecast_model()
precompute_forecasts()

client = TestClient(app)

# Login to get a token (use seeded admin credentials from env, not hardcoded)
import os
admin_email = os.environ.get("PEESTOCKS_TEST_ADMIN_EMAIL", "admin@peestocks.com")
admin_password = os.environ.get("PEESTOCKS_TEST_ADMIN_PASSWORD")
if not admin_password:
    print("Set PEESTOCKS_TEST_ADMIN_PASSWORD env var to run this test (no hardcoded passwords).")
    raise SystemExit(1)

login_res = client.post("/api/auth/login", json={"email": admin_email, "password": admin_password})
check("login succeeds", login_res.status_code == 200)
token = login_res.json()["access_token"]
headers = {"Authorization": f"Bearer {token}"}

# Pick a real symbol that should have data — query instruments table
res = client.get("/api/forecasts/RELIANCE", headers=headers)
check("known symbol returns 200 or 404 (not 500)", res.status_code in (200, 404))
if res.status_code == 200:
    body = res.json()
    check("response has 'days' list", isinstance(body.get("days"), list))
    check("days list has up to 10 entries", len(body["days"]) <= 10)

res_missing = client.get("/api/forecasts/NOTASYMBOL123", headers=headers)
check("unknown symbol returns 404", res_missing.status_code == 404)

if failures:
    print(f"\n{len(failures)} check(s) failed: {failures}")
    raise SystemExit(1)
print("\nAll checks passed.")
```

**Step 4: Run test to verify it passes**

Run:
```bash
cd "/Users/srikrishnasingh/AG1 BB/PEESTOCKS/backend" && source venv/bin/activate && PYTHONPATH=. PEESTOCKS_TEST_ADMIN_PASSWORD='<the password from reset_admin_password.py output>' python test_forecasts_api.py
```
Expected: `All checks passed.`

Note: this is a deliberate deviation from blind TDD ("write failing test first") because the endpoint depends on the DB/model pipeline from Tasks 1–4 already existing — there's no meaningful "red" state to observe beyond "endpoint doesn't exist yet," which Task 6 Step 1 already resolves before the test can be meaningfully run. Confirm the import fails before Step 1 if you want to see red:
Run: `python -c "from app.api.forecasts import router"` before Step 1 exists → `ModuleNotFoundError`.

---

### Task 7: Frontend API client method

**Files:**
- Modify: `frontend/src/lib/api.js`

**Step 1:** Add a method in the `ApiClient` class body, near `getEod`:

```js
getForecast(symbol) {
  return this.request(`/forecasts/${symbol}`);
}
```

**Step 2:** No automated test (this codebase has no frontend test suite) — verified manually in Task 8.

---

### Task 8: Chart page — forecast overlay toggle

**Files:**
- Modify: `frontend/src/app/dashboard/charts/page.js`

**Step 1:** Add a new indicator menu entry near the existing list around line 3142 (e.g. alongside `{ id:'sma20', label:'SMA 20', color:'#FF6600', panel:'main' }`):

```js
{ id: 'forecast_lstm', label: 'AI Forecast (LSTM)', color: '#22d3ee', panel: 'main' },
```

**Step 2:** In the indicator-rendering loop (the same area as the `maLines` loop around line 3972), add a branch that fetches and renders the forecast when this indicator is toggled on. Since this requires an async API call (unlike the synchronous client-side `computeSMA` etc.), add a separate `useEffect` rather than inlining it in the synchronous render loop:

```js
const [forecastData, setForecastData] = useState(null);
const forecastSeriesRefs = useRef({ line: null, upper: null, lower: null });

useEffect(() => {
  const showForecast = maLines.some(m => m.id === 'forecast_lstm' && m.visible);
  if (!showForecast || !symbol || !candleData.length) {
    setForecastData(null);
    return;
  }
  api.getForecast(symbol)
    .then(setForecastData)
    .catch((err) => {
      console.error("Forecast fetch failed:", err);
      setForecastData(null);
    });
}, [symbol, maLines, candleData.length]);

useEffect(() => {
  if (!chartRef.current) return;
  const chart = chartRef.current;

  // Clear previous forecast series
  Object.values(forecastSeriesRefs.current).forEach(s => {
    if (s) { try { chart.removeSeries(s); } catch (e) {} }
  });
  forecastSeriesRefs.current = { line: null, upper: null, lower: null };

  if (!forecastData || !forecastData.days?.length || !candleData.length) return;

  const lastBar = candleData[candleData.length - 1];
  const lastTime = lastBar.time;
  const oneDaySec = 24 * 60 * 60;

  const lineData = [{ time: lastTime, value: lastBar.close }];
  const upperData = [{ time: lastTime, value: lastBar.close }];
  const lowerData = [{ time: lastTime, value: lastBar.close }];

  forecastData.days.forEach((d, i) => {
    const t = lastTime + oneDaySec * (i + 1);
    lineData.push({ time: t, value: d.predicted_close });
    upperData.push({ time: t, value: d.upper_band });
    lowerData.push({ time: t, value: d.lower_band });
  });

  const upperSeries = chart.addSeries(LineSeries, {
    color: 'rgba(34, 211, 238, 0.3)', lineWidth: 1, lineStyle: LineStyle.Dotted,
    lastValueVisible: false, priceLineVisible: false,
  }, 0);
  upperSeries.setData(upperData);

  const lowerSeries = chart.addSeries(LineSeries, {
    color: 'rgba(34, 211, 238, 0.3)', lineWidth: 1, lineStyle: LineStyle.Dotted,
    lastValueVisible: false, priceLineVisible: false,
  }, 0);
  lowerSeries.setData(lowerData);

  const lineSeries = chart.addSeries(LineSeries, {
    color: '#22d3ee', lineWidth: 2, lineStyle: LineStyle.Dashed,
    title: forecastData.is_stale ? 'Forecast (stale)' : 'AI Forecast',
    lastValueVisible: true, priceLineVisible: false,
  }, 0);
  lineSeries.setData(lineData);

  forecastSeriesRefs.current = { line: lineSeries, upper: upperSeries, lower: lowerSeries };
}, [forecastData, candleData]);
```

Note: exact variable names (`chartRef`, `candleData`, `maLines`, `symbol`) must be confirmed against the real surrounding code in `charts/page.js` before pasting — this file is ~4000 lines and wasn't read in full; the executor must grep for these identifiers first and adapt names exactly, since approximate names were inferred from the partial read in research.

**Step 3:** Add a small accuracy/staleness badge near the indicator toggle UI. Find wherever the indicator toggle checkboxes render (same area as the `maLines.map(...)` UI list) and add, conditionally when `forecast_lstm` is active and `forecastData` is loaded:

```jsx
{forecastData && (
  <span style={{ fontSize: '11px', color: forecastData.is_stale ? '#f59e0b' : '#9ca3af', marginLeft: 8 }}>
    {forecastData.is_stale ? '⚠ Forecast stale' : `Forecast as of ${forecastData.as_of_date}`}
  </span>
)}
```

**Step 4: Manual verification**

Run the dev server and check in browser:
```bash
cd "/Users/srikrishnasingh/AG1 BB/PEESTOCKS/frontend" && npm run dev
```
Navigate to `http://localhost:3000/dashboard/charts?symbol=RELIANCE`, log in with the reset admin credentials, toggle "AI Forecast (LSTM)" on. Expected: a dashed cyan line extends from the last candle 10 days forward, with a dotted upper/lower band, and a small "Forecast as of YYYY-MM-DD" label appears.

If the API returns 404 `insufficient_history`, the toggle should silently show no forecast line (already handled — `setForecastData(null)` on catch) rather than crash.

---

### Task 9: AI Assistant — "forecast SYMBOL" intent

**Files:**
- Modify: `backend/app/api/chatbot.py` (or wherever `chatbotQuery`'s backend intent parser lives — confirm exact file via `grep -rn "chatbot" backend/app/api/`)
- Modify: `frontend/src/app/dashboard/assistant/page.js`

**Step 1:** Locate the chatbot intent-parsing logic.

Run: `grep -rln "intent" "/Users/srikrishnasingh/AG1 BB/PEESTOCKS/backend/app/api/" "/Users/srikrishnasingh/AG1 BB/PEESTOCKS/backend/app/services/"`

Read whichever file defines intent matching (likely a `chatbot_router` handler or a `chatbot_service.py`) to find the pattern used for existing intents (e.g. how "RSI oversold in nifty 50" gets parsed) before adding a new branch.

**Step 2:** Add a new intent branch that matches patterns like `forecast SYMBOL`, `predict SYMBOL`, following whatever regex/keyword convention the existing parser uses. On match: look up the instrument, call the same `Forecast` query logic as the `/api/forecasts/{symbol}` endpoint (consider refactoring the lookup into a shared function in `forecast_service.py` to avoid duplicating the SQLAlchemy query — call it `get_latest_forecast(db, instrument_id)` and have both the API endpoint and the chatbot handler call it), and return a chat response with a `forecast` field containing the same `ForecastOut`-shaped data instead of `matches`.

**Step 3:** In `frontend/src/app/dashboard/assistant/page.js`, extend the message rendering (the block at line ~143 `{!isUser && m.matches && m.matches.length > 0 && (...)}`) with a sibling conditional:

```jsx
{!isUser && m.forecast && (
  <div className={styles.resultsContainer}>
    <p style={{ fontSize: '0.85rem', color: '#9ca3af' }}>
      {m.forecast.symbol} — {m.forecast.is_stale ? 'Forecast (stale)' : `as of ${m.forecast.as_of_date}`}
    </p>
    <Link href={`/dashboard/charts?symbol=${m.forecast.symbol}&tf=D`} className={styles.chartLink}>
      View full forecast on chart →
    </Link>
  </div>
)}
```
(Keep this minimal — a full inline sparkline is a nice-to-have, not required for the core feature; cut it to stay YAGNI unless explicitly requested later.)

**Step 4: Manual verification**

In the running dev app, go to `/dashboard/assistant`, type `forecast RELIANCE`, confirm a reply appears with the symbol/date and a working link to the chart page with the forecast pre-toggled (note: the link as written doesn't auto-enable the toggle — that's a known follow-up, not in scope for this plan; flag it in the final summary rather than silently expanding scope).

---

### Task 10: End-to-end smoke check

**Step 1:** Run all new backend tests in sequence to confirm nothing regressed:

```bash
cd "/Users/srikrishnasingh/AG1 BB/PEESTOCKS/backend" && source venv/bin/activate && PYTHONPATH=. python test_forecast_service.py && PYTHONPATH=. python test_lstm_model.py && PYTHONPATH=. PEESTOCKS_TEST_ADMIN_PASSWORD='<password>' python test_forecasts_api.py
```
Expected: all three print `All checks passed.`

**Step 2:** Run the existing test suite to confirm no regression to unrelated features:

```bash
cd "/Users/srikrishnasingh/AG1 BB/PEESTOCKS/backend" && source venv/bin/activate && PYTHONPATH=. python test_scans.py && PYTHONPATH=. python test_pattern_scan_upsert.py
```
Expected: both pass as before (these are pre-existing tests, unrelated to this feature — only running to catch accidental import-time breakage in shared modules like `models.py`).

**Step 3:** Manual full walkthrough in browser per Task 8 Step 4 and Task 9 Step 4.

---

## Out of scope / explicit follow-ups (do not implement now)

- Auto-enabling the forecast toggle via URL param (`?forecast=1`) — mentioned in the original design but cut for YAGNI; only build if requested.
- S3 model artifact storage (`boto3` is available in requirements but unused here) — local disk under `backend/app/ml/forecast_lstm.pt` is sufficient for a single-server deployment; revisit only if deploying to multiple workers that need a shared model file.
- Cleaning up the stale duplicate `peestock/backend` / `peestock/frontend` tree — flagged but not addressed by this plan.
- Per-sector or per-instrument fine-tuned models — pooled model only, per the approved design.
