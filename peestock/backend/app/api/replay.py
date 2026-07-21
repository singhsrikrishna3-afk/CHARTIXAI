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
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    """Generate bar replay frames for a symbol.

    Returns OHLCV + computed indicators at each step for visual backtesting.
    """
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
            OhlcvEod.instrument_id == instrument.id
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

    engine = BarReplayEngine(df, indicator_configs or None)
    frames = engine.replay(start=start_bar, step=step)
    repaint_checks = engine.check_repaint()

    return {
        "symbol": symbol.upper(),
        "total_bars": len(df),
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
