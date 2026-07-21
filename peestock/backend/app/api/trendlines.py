"""PEESTOCK — Trendlines API."""

from typing import Optional

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select, desc, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models import Trendline, Instrument
from app.schemas import TrendlineOut
from app.auth import get_current_user

router = APIRouter(prefix="/api/trendlines", tags=["trendlines"])


@router.get("/", response_model=list[TrendlineOut])
async def list_trendlines(
    symbol: Optional[str] = Query(None),
    active_only: bool = Query(True),
    limit: int = Query(50, le=100),
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    """List detected trendlines, optionally filtered by symbol."""
    q = select(Trendline, Instrument.symbol).join(
        Instrument, Trendline.instrument_id == Instrument.id
    )
    if active_only:
        q = q.where(Trendline.is_active == True)
    if symbol:
        q = q.where(Instrument.symbol == symbol.upper())
        
    q = q.order_by(desc(Trendline.created_at)).limit(limit)
    result = await db.execute(q)
    
    trendlines = []
    for row in result.all():
        t = row[0]
        out = TrendlineOut.model_validate(t)
        out.symbol = row[1]
        trendlines.append(out)
    return trendlines


@router.get("/{symbol}", response_model=list[TrendlineOut])
async def get_trendlines_for_symbol(
    symbol: str,
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    """Get all active trendlines for a specific symbol."""
    q = (
        select(Trendline, Instrument.symbol)
        .join(Instrument, Trendline.instrument_id == Instrument.id)
        .where(Instrument.symbol == symbol.upper(), Trendline.is_active == True)
        .order_by(desc(Trendline.created_at))
    )
    result = await db.execute(q)
    
    trendlines = []
    for row in result.all():
        t = row[0]
        out = TrendlineOut.model_validate(t)
        out.symbol = row[1]
        trendlines.append(out)
    return trendlines
