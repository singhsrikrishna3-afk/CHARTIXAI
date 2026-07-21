"""Chartix — Backtesting API.

POST /api/backtest/run — backtest a no-code scanner (raw conditions, same shape as
/scanners/preview) over a single symbol or an index basket, with stop-loss / target
exits. Long-only v1.
"""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.auth import get_current_user
from app.models import User, Instrument
from app.schemas import ScannerCondition
from app.services import backtest as bt

router = APIRouter(prefix="/api/backtest", tags=["backtest"])

# Keep index backtests interactive on the memory-constrained box.
MAX_BASKET = 100


class BacktestRequest(BaseModel):
    conditions: list[ScannerCondition]
    logic: str = "AND"
    # Universe: exactly one of these picks the scope. symbol → one stock;
    # index → an index's constituents; sector → a sector; scope="all" → the
    # whole liquid universe (capped). None + no scope defaults to "all".
    symbol: Optional[str] = None
    index: Optional[str] = None
    sector: Optional[str] = None
    scope: Optional[str] = None            # "all" for the full universe
    timeframe: str = "D"
    stop_loss_pct: float = Field(5.0, gt=0, le=90)
    target_pct: float = Field(10.0, gt=0, le=500)
    max_holding_bars: int = Field(60, ge=1, le=500)
    lookback_bars: int = Field(1500, ge=60, le=5000)


@router.post("/run")
async def run_backtest_endpoint(
    body: BacktestRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    if not body.conditions:
        raise HTTPException(status_code=400, detail="At least one scanner condition is required.")

    # Weekly/monthly backtests respect the same subscription gate as scans.
    from app.services.subscription_validator import validate_timeframe_access
    await validate_timeframe_access(user, body.timeframe, db)

    # Resolve the instrument universe (single / index / sector / all).
    scope_label = None
    if body.symbol:
        instr = (await db.execute(
            select(Instrument).where(Instrument.symbol == body.symbol.upper())
        )).scalar_one_or_none()
        if not instr:
            raise HTTPException(status_code=404, detail=f"Unknown symbol '{body.symbol}'.")
        instruments = [instr]
        scope_label = f"{body.symbol.upper()} (single stock)"
    else:
        from app.api.scans import _load_all_instruments
        sector = body.sector if (body.sector and body.sector.lower() not in ("all", "")) else None
        index = body.index if (body.index and body.index.lower() not in ("all", "")) else None
        instruments = await _load_all_instruments(db, sector=sector, index=index)
        if not instruments:
            scope = index or sector or "the universe"
            raise HTTPException(status_code=404, detail=f"No instruments found for '{scope}'.")
        # Keep only liquid EQ names for basket runs; cap for the memory-limited box.
        instruments = [i for i in instruments if getattr(i, "segment", "EQ") in ("EQ", "IND")]
        instruments = instruments[:MAX_BASKET]
        scope_label = (index and index.replace("_", " ")) or sector or "All liquid stocks"

    conditions = [c.model_dump() for c in body.conditions]
    try:
        result = await bt.run_backtest(
            db, conditions, body.logic, instruments,
            timeframe=body.timeframe,
            stop_loss_pct=body.stop_loss_pct,
            target_pct=body.target_pct,
            max_holding_bars=body.max_holding_bars,
            lookback_bars=body.lookback_bars,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=f"Invalid strategy condition: {e}")

    result["scope"] = {"label": scope_label, "symbol": body.symbol,
                       "index": body.index, "sector": body.sector,
                       "instruments": len(instruments),
                       "capped": (not body.symbol) and len(instruments) >= MAX_BASKET}
    return result
