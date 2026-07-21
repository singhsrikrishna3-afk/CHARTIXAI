"""PEESTOCK — Bar Replay API."""

from typing import Optional
from datetime import date

from fastapi import APIRouter, Depends, Query, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

import pandas as pd

from app.database import get_db
from app.models import Instrument, OhlcvEod
from app.auth import get_current_user
from app.services.bar_replay import BarReplayEngine

router = APIRouter(prefix="/api/replay", tags=["replay"])


@router.get("/{symbol}")
async def get_replay(
    symbol: str,
    start_bar: int = Query(50, ge=20),
    step: int = Query(1, ge=1, le=10),
    indicators: Optional[str] = Query("sma:20,rsi:14"),
    window: int = Query(250, ge=30, le=750,
                        description="How many bars the replay session covers"),
    random_start: bool = Query(False,
                               description="Drop into a random point in history — no hindsight"),
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    """Generate bar replay frames for a symbol.

    Returns OHLCV + computed indicators at each step for visual backtesting.
    By default replays the most recent `window` bars; with random_start=true the
    window is placed at a random point in the instrument's history, which is the
    honest way to practice — you can't lean on remembering what happened next.
    """
    # Random-period practice mode is an EOD Basic+ feature; latest-window
    # replay is free (matches the pricing ladder).
    if random_start:
        from app.services.subscription_validator import require_tier
        await require_tier(_user, db, "eod_basic", "Random-period replay practice")

    # Get instrument
    result = await db.execute(
        select(Instrument).where(Instrument.symbol == symbol.upper())
    )
    instrument = result.scalar_one_or_none()
    if not instrument:
        raise HTTPException(status_code=404, detail=f"Instrument {symbol} not found")

    # Get OHLCV data
    rows = (await db.execute(
        select(OhlcvEod).where(
            (OhlcvEod.instrument_id == instrument.id) &
            (OhlcvEod.open.is_not(None)) &
            (OhlcvEod.high.is_not(None)) &
            (OhlcvEod.low.is_not(None)) &
            (OhlcvEod.close.is_not(None))
        ).order_by(OhlcvEod.time)
    )).scalars().all()

    if len(rows) < start_bar + 10:
        raise HTTPException(status_code=400, detail="Not enough data for replay")

    df = pd.DataFrame([{
        "time": r.time,
        "open": float(r.open),
        "high": float(r.high),
        "low": float(r.low),
        "close": float(r.close),
        "volume": int(r.volume or 0),
    } for r in rows])

    # Parse indicator configs
    indicator_configs = []
    if indicators:
        for ind_str in indicators.split(","):
            parts = ind_str.strip().split(":")
            name = parts[0]
            params = {}
            if len(parts) > 1:
                params["period"] = int(parts[1])
            indicator_configs.append({"name": name, "params": params})

    # Place the replay window: [warmup … end_idx-window … end_idx]. Warmup bars
    # before the window keep indicators (SMA/RSI) valid from the first frame.
    warmup = max(start_bar, 60)
    n = len(df)
    window = min(window, n - warmup - 1)
    if window < 30:
        raise HTTPException(status_code=400, detail="Not enough history for a replay window")
    if random_start:
        import random as _random
        end_idx = _random.randint(warmup + window, n)
    else:
        end_idx = n

    engine = BarReplayEngine(df, indicator_configs or None)
    frames = engine.replay(start=end_idx - window, end=end_idx, step=step)
    repaint_checks = engine.check_repaint()

    return {
        "symbol": symbol.upper(),
        "total_bars": len(df),
        "window": window,
        "random_start": random_start,
        "period": {"from": str(df["time"].iloc[end_idx - window]),
                   "to": str(df["time"].iloc[end_idx - 1])},
        "frames": [
            {
                "bar_index": f.bar_index,
                "time": str(f.time),
                "ohlcv": f.ohlcv,
                "indicators": f.indicators,
                "signals": f.signals,
            }
            for f in frames
        ],
        "repaint_checks": [
            {
                "indicator": rc.indicator,
                "is_repainting": rc.is_repainting,
                "repaint_bars_count": len(rc.repaint_bars),
                "details": rc.details,
            }
            for rc in repaint_checks
        ],
    }
