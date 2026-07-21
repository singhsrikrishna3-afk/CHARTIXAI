"""PEESTOCK — Instruments & OHLCV data API."""

from datetime import date
from typing import Optional

from fastapi import APIRouter, Depends, Query, BackgroundTasks
import subprocess
import os
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models import Instrument, OhlcvEod
from app.schemas import InstrumentOut, OhlcvBar
from app.auth import get_current_user

router = APIRouter(prefix="/api/instruments", tags=["instruments"])


@router.get("/", response_model=list[InstrumentOut])
async def list_instruments(
    search: Optional[str] = Query(None),
    intraday_only: bool = Query(False),
    limit: int = Query(50, le=500),
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    q = select(Instrument).where(Instrument.is_active == True)
    if search:
        q = q.where(Instrument.symbol.ilike(f"%{search}%"))
    if intraday_only:
        q = q.where(Instrument.is_intraday == True)
    q = q.order_by(Instrument.symbol).limit(limit)
    result = await db.execute(q)
    return [InstrumentOut.model_validate(r) for r in result.scalars().all()]


@router.get("/watchlist")
async def get_watchlist(db: AsyncSession = Depends(get_db)):
    # Raw SQL to get the latest close and volume for each instrument using SQLite's max() guarantee
    query = """
        SELECT i.symbol, i.name, latest.close as price, latest.volume as volume
        FROM instruments i
        JOIN (
            SELECT instrument_id, close, volume, max(time) as latest_time
            FROM ohlcv_eod
            GROUP BY instrument_id
        ) latest ON latest.instrument_id = i.id
        WHERE i.is_active = 1
        ORDER BY i.symbol ASC
    """
    from sqlalchemy import text
    from app.models import Instrument
    result = await db.execute(text(query), bind_arguments={"mapper": Instrument})
    data = result.fetchall()
    return [{"symbol": row[0], "name": row[1], "price": row[2], "volume": row[3]} for row in data]

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

    q = select(OhlcvEod).where(OhlcvEod.instrument_id == instrument.id)
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


@router.post("/sync")
async def trigger_sync(background_tasks: BackgroundTasks, _user=Depends(get_current_user)):
    """Trigger a background sync using Yahoo Finance."""
    def run_sync_script():
        script_path = os.path.join(os.path.dirname(__file__), "..", "..", "scripts", "sync_yfinance.py")
        venv_python = os.path.join(os.path.dirname(__file__), "..", "..", "venv", "bin", "python")
        from app.config import get_settings
        env = os.environ.copy()
        env["DATABASE_URL"] = get_settings().DATABASE_URL
        subprocess.run([venv_python, script_path, "1d"], env=env)
        
        # Also run pattern scan
        scan_script = f"import sys; sys.path.append('app/workers'); from tasks_eod import run_pattern_scan, run_trendline_scan; run_pattern_scan(); run_trendline_scan()"
        subprocess.run([venv_python, "-c", scan_script], env=env)

    background_tasks.add_task(run_sync_script)
    return {"status": "sync_started", "message": "Data download and pattern scan started in background."}
