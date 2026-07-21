"""PEESTOCK — Instruments & OHLCV data API."""

import logging
import threading
from datetime import date
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, BackgroundTasks
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models import Instrument, OhlcvEod, User
from app.schemas import InstrumentOut, OhlcvBar
from app.auth import get_current_user

router = APIRouter(prefix="/api/instruments", tags=["instruments"])
logger = logging.getLogger(__name__)

_sync_lock = threading.Lock()
_sync_in_progress = False


@router.get("/", response_model=list[InstrumentOut])
async def list_instruments(
    search: Optional[str] = Query(None),
    intraday_only: bool = Query(False),
    sector: Optional[str] = Query(None),
    limit: int = Query(50, le=500),
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    q = select(Instrument).where(Instrument.is_active == True)
    if search:
        q = q.where(Instrument.symbol.ilike(f"%{search}%"))
    if intraday_only:
        q = q.where(Instrument.is_intraday == True)
    if sector:
        q = q.where(Instrument.sector == sector)
    q = q.order_by(Instrument.symbol).limit(limit)
    result = await db.execute(q)
    return [InstrumentOut.model_validate(r) for r in result.scalars().all()]


@router.get("/sectors")
async def list_sectors(db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(Instrument.sector)
        .where(Instrument.sector.is_not(None))
        .distinct()
        .order_by(Instrument.sector)
    )
    return [r[0] for r in result.all()]


@router.get("/indices")
async def list_indices(db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(Instrument.symbol, Instrument.name)
        .where(Instrument.segment == "IND", Instrument.is_active == True)
        .order_by(Instrument.name)
    )
    return [{"symbol": r[0], "name": r[1]} for r in result.all()]


@router.get("/watchlist")
async def get_watchlist(db: AsyncSession = Depends(get_db)):
    # Raw SQL with CTE window functions to calculate absolute change and change percent
    query = """
        WITH RankedPrices AS (
            SELECT 
                instrument_id, 
                close, 
                volume,
                time,
                LAG(close) OVER (PARTITION BY instrument_id ORDER BY time) as prev_close,
                ROW_NUMBER() OVER (PARTITION BY instrument_id ORDER BY time DESC) as rn
            FROM ohlcv_eod
        )
        SELECT i.symbol, i.name, r.close as price, r.volume as volume, r.prev_close
        FROM instruments i
        JOIN RankedPrices r ON r.instrument_id = i.id AND r.rn = 1
        WHERE i.is_active = 1
        ORDER BY i.symbol ASC
    """
    from sqlalchemy import text
    result = await db.execute(text(query))
    data = result.fetchall()
    
    watchlist = []
    for row in data:
        symbol, name, price, volume, prev_close = row
        price_val = float(price) if price is not None else 0.0
        prev_close_val = float(prev_close) if prev_close is not None else price_val
        chg_abs = price_val - prev_close_val
        chg_pct = (chg_abs / prev_close_val * 100) if prev_close_val else 0.0
        watchlist.append({
            "symbol": symbol,
            "name": name,
            "price": price_val,
            "volume": int(volume) if volume is not None else 0,
            "change": chg_abs,
            "change_pct": chg_pct
        })
    return watchlist

@router.get("/{symbol}/eod", response_model=list[OhlcvBar])
async def get_eod(
    symbol: str,
    start: Optional[date] = Query(None),
    end: Optional[date] = Query(None),
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    inst = await db.execute(select(Instrument).where(Instrument.symbol == symbol.upper()))
    instrument = inst.scalar_one_or_none()
    if not instrument:
        return []

    q = select(OhlcvEod).where(
        (OhlcvEod.instrument_id == instrument.id) &
        (OhlcvEod.open.is_not(None)) &
        (OhlcvEod.high.is_not(None)) &
        (OhlcvEod.low.is_not(None)) &
        (OhlcvEod.close.is_not(None))
    )
    if start:
        q = q.where(OhlcvEod.time >= start)
    if end:
        q = q.where(OhlcvEod.time <= end)
    q = q.order_by(OhlcvEod.time)
    result = await db.execute(q)
    return [OhlcvBar(
        time=r.time, open=float(r.open), high=float(r.high),
        low=float(r.low), close=float(r.close), volume=int(r.volume) if r.volume else 0,
    ) for r in result.scalars().all()]


def _run_sync_job():
    global _sync_in_progress
    try:
        from app.workers.tasks_eod import run_eod_catchup
        result = run_eod_catchup()
        logger.info("EOD catchup result: %s", result)
    except Exception:
        logger.exception("EOD catchup failed")
    finally:
        _sync_in_progress = False


@router.post("/sync")
async def trigger_sync(background_tasks: BackgroundTasks, _user=Depends(get_current_user)):
    """Trigger a background EOD sync against the real NSE bhavcopy feed,
    backfilling every trading day missed since the last stored date."""
    global _sync_in_progress
    with _sync_lock:
        if _sync_in_progress:
            raise HTTPException(status_code=409, detail="A sync is already in progress.")
        _sync_in_progress = True

    background_tasks.add_task(_run_sync_job)
    return {"status": "sync_started", "message": "NSE bhavcopy catch-up and pattern scan started in background."}


@router.get("/sync/status")
async def sync_status(_user=Depends(get_current_user)):
    return {"in_progress": _sync_in_progress}


@router.get("/holidays")
async def get_holidays(
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    """Retrieve all NSE trading holidays."""
    from app.services.holidays import get_all_holidays, sync_nse_holidays
    
    holidays = await get_all_holidays(db)
    if not holidays:
        logger.info("Holidays table empty. Seeding holidays on the fly...")
        await sync_nse_holidays(db, force_download=False)
        holidays = await get_all_holidays(db)
        
    return [
        {
            "id": h.id,
            "date": h.trading_date.isoformat(),
            "day": h.week_day,
            "description": h.description,
            "holiday_type": h.holiday_type,
        }
        for h in holidays
    ]


@router.post("/holidays/sync")
async def sync_holidays(
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    """Manually trigger a download of holidays from the NSE API, falling back to curated list if needed."""
    from app.services.holidays import sync_nse_holidays, get_all_holidays
    
    count, source = await sync_nse_holidays(db, force_download=True)
    holidays = await get_all_holidays(db)
    
    return {
        "status": "success",
        "message": f"Successfully synced {count} holidays.",
        "source": source,
        "holidays": [
            {
                "id": h.id,
                "date": h.trading_date.isoformat(),
                "day": h.week_day,
                "description": h.description,
                "holiday_type": h.holiday_type,
            }
            for h in holidays
        ]
    }



# ── Fundamentals ─────────────────────────────────────────────
@router.get("/{symbol}/fundamentals")
async def get_fundamentals(
    symbol: str,
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    """Latest fundamental snapshot for one instrument (percent fields are
    percentages, debt_to_equity is a ratio). 404 until ingested."""
    from fastapi import HTTPException
    from app.models import Instrument, Fundamentals

    instr = (await db.execute(
        select(Instrument).where(Instrument.symbol == symbol.upper())
    )).scalar_one_or_none()
    if not instr:
        raise HTTPException(status_code=404, detail=f"Unknown symbol '{symbol}'.")

    f = (await db.execute(
        select(Fundamentals).where(Fundamentals.instrument_id == instr.id)
    )).scalar_one_or_none()
    if not f:
        raise HTTPException(status_code=404, detail=f"No fundamentals ingested yet for {symbol.upper()}.")

    def num(v):
        return float(v) if v is not None else None

    return {
        "symbol": instr.symbol,
        "market_cap": int(f.market_cap) if f.market_cap is not None else None,
        "pe": num(f.pe), "forward_pe": num(f.forward_pe), "pb": num(f.pb),
        "roe": num(f.roe), "debt_to_equity": num(f.debt_to_equity),
        "dividend_yield": num(f.dividend_yield), "eps": num(f.eps),
        "revenue_growth": num(f.revenue_growth), "earnings_growth": num(f.earnings_growth),
        "profit_margin": num(f.profit_margin), "book_value": num(f.book_value),
        "week52_high": num(f.week52_high), "week52_low": num(f.week52_low),
        "promoter_holding": num(f.promoter_holding),
        "sector": f.sector_src or instr.sector, "industry": f.industry_src or instr.industry,
        "updated_at": f.updated_at.isoformat() if f.updated_at else None,
    }
