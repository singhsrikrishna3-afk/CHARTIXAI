"""PEESTOCK — Screener API (pattern scan results)."""

from typing import Optional

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select, desc
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models import DetectedPattern, Instrument
from app.schemas import PatternOut
from app.auth import get_current_user

router = APIRouter(prefix="/api/screener", tags=["screener"])


@router.get("/patterns", response_model=list[PatternOut])
async def list_patterns(
    pattern_type: Optional[str] = Query(None),
    status: Optional[str] = Query("forming"),
    timeframe: Optional[str] = Query("D"),
    limit: int = Query(50, le=200),
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    """List detected chart patterns with optional filters."""
    q = select(DetectedPattern, Instrument.symbol).join(
        Instrument, DetectedPattern.instrument_id == Instrument.id
    )
    if pattern_type:
        q = q.where(DetectedPattern.pattern_type == pattern_type)
    if status:
        q = q.where(DetectedPattern.status == status)
    if timeframe:
        q = q.where(DetectedPattern.timeframe == timeframe)

    q = q.order_by(desc(DetectedPattern.detection_time)).limit(limit)
    result = await db.execute(q)

    patterns = []
    for row in result.all():
        p = row[0]
        out = PatternOut.model_validate(p)
        out.symbol = row[1]
        patterns.append(out)
    return patterns


@router.post("/trigger-scan")
async def trigger_scan(db: AsyncSession = Depends(get_db), _user=Depends(get_current_user)):
    """Manually trigger pattern and trendline detection scans."""
    from app.workers.tasks_eod import run_pattern_scan, run_trendline_scan
    
    # We use .delay() for Celery, but here we can try to run it directly if Celery isn't setup
    # or just return a message saying it's queued.
    try:
        run_pattern_scan.delay()
        run_trendline_scan.delay()
        return {"status": "success", "message": "Scans triggered in background"}
    except Exception as e:
        # If celery is not running, run synchronously (might be slow but works for dev)
        run_pattern_scan()
        run_trendline_scan()
        return {"status": "success", "message": "Scans completed synchronously"}

