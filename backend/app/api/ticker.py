import logging
from typing import Optional
from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from app.database import get_db
from app.models.models import Instrument, OhlcvEod

router = APIRouter(prefix="/api/ticker", tags=["ticker"])
logger = logging.getLogger(__name__)

DEFAULT_SYMBOLS = ["RELIANCE", "TCS", "HDFCBANK", "INFY", "SBIN",
                   "ICICIBANK", "BAJFINANCE", "MARUTI", "TITAN", "AXISBANK"]

@router.get("")
async def get_ticker(
    symbols: Optional[str] = Query(None, description="Comma-separated symbols"),
    db: AsyncSession = Depends(get_db),
):
    """Public endpoint — no auth required. Returns latest EOD close + day change for the given symbols."""
    sym_list = [s.strip().upper() for s in symbols.split(",")] if symbols else DEFAULT_SYMBOLS
    sym_list = sym_list[:20]  # cap at 20 to prevent abuse

    result = []
    for sym in sym_list:
        inst_q = await db.execute(select(Instrument).where(Instrument.symbol == sym))
        inst = inst_q.scalar_one_or_none()
        if not inst:
            continue

        # Get last 2 trading days to compute change
        bars_q = await db.execute(
            select(OhlcvEod)
            .where(OhlcvEod.instrument_id == inst.id)
            .order_by(OhlcvEod.time.desc())
            .limit(2)
        )
        bars = bars_q.scalars().all()
        if not bars or bars[0].close is None:
            continue

        today_close = float(bars[0].close)
        prev_close = float(bars[1].close) if len(bars) > 1 and bars[1].close else today_close
        change_pct = ((today_close - prev_close) / prev_close * 100) if prev_close > 0 else 0.0

        result.append({
            "sym": sym,
            "price": f"{today_close:,.2f}",
            "chg": f"{'+' if change_pct >= 0 else ''}{change_pct:.2f}%",
            "change_pct": change_pct,
            "date": bars[0].time.strftime("%d %b") if hasattr(bars[0].time, "strftime") else str(bars[0].time),
        })

    return result
