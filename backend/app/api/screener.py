"""PEESTOCK — Screener API (pattern scan results)."""

import json
from typing import Optional

from fastapi import APIRouter, Depends, Query
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.schemas import PatternOut
from app.auth import get_current_user

router = APIRouter(prefix="/api/screener", tags=["screener"])


@router.get("/patterns", response_model=list[PatternOut])
async def list_patterns(
    pattern_type: Optional[str] = Query(None),
    status: Optional[str] = Query("forming"),
    timeframe: Optional[str] = Query("D"),
    sector: Optional[str] = Query(None),
    index: Optional[str] = Query(None),
    min_confidence: float = Query(0.45, ge=0, le=1,
                                  description="Hide patterns below this confidence/win-rate (0 to show all)"),
    liquid_only: bool = Query(True, description="Only instruments with ≥₹1cr avg daily turnover"),
    limit: int = Query(50, le=200),
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    """List detected chart patterns, capped to the single most impactful
    pattern per instrument. Quality-gated by default: illiquid instruments and
    patterns whose back-tested win rate / fit confidence is worse than ~coin-flip
    are hidden unless explicitly requested."""
    if timeframe:
        from app.services.subscription_validator import validate_timeframe_access
        await validate_timeframe_access(_user, timeframe, db)

    from app.services import scan_cache, scan_history
    _params = {"pattern_type": pattern_type, "status": status, "timeframe": timeframe,
               "sector": sector, "index": index, "limit": limit}
    _ck = scan_cache.make_key("screener_patterns",
                              [pattern_type, status, timeframe, sector, index,
                               min_confidence, liquid_only, limit])
    _cached = scan_cache.get(_ck)
    if _cached is not None:
        return _cached

    filters = []
    params: dict = {"limit": limit}
    if pattern_type:
        filters.append("dp.pattern_type = :pattern_type")
        params["pattern_type"] = pattern_type
    if status:
        filters.append("dp.status = :status")
        params["status"] = status
    if timeframe:
        filters.append("dp.timeframe = :timeframe")
        params["timeframe"] = timeframe
    if sector and sector.lower() not in ("all", "none", ""):
        filters.append("i.sector = :sector")
        params["sector"] = sector
    if index and index.lower() not in ("all", "none", ""):
        filters.append("""
            i.id IN (
                SELECT instrument_id FROM index_constituents WHERE index_id = (
                    SELECT id FROM instruments WHERE symbol = :index_symbol OR name = :index_name
                )
            )
        """)
        params["index_symbol"] = index
        params["index_name"] = index
    # Two confidence scales coexist: BACKTESTED patterns carry a measured
    # historical win rate (honest, mostly 0.3–0.8), while non-backtested shapes
    # (triangles, wedges…) carry a geometric fit score that runs hot (0.6–0.9).
    # Ranking raw numbers lets a 0.9 "nice-looking triangle" bury a 0.49 measured
    # edge. Discount geometric fits (×0.55 ≈ calibrates a perfect fit to the
    # ~coin-flip win rate the average backtested pattern actually delivers) and
    # gate/rank on that effective value.
    eff_conf = ("CASE WHEN json_extract(dp.key_points,'$.confidence_source') = 'backtested' "
                "THEN dp.confidence ELSE dp.confidence * 0.55 END")
    if min_confidence > 0:
        filters.append(f"{eff_conf} >= :min_conf")
        params["min_conf"] = min_confidence
    if liquid_only:
        # 20-bar average turnover ≥ ₹1 crore — rides the (instrument_id, time DESC)
        # index like the latest_close subquery, so it stays fast.
        filters.append("""
            (SELECT AVG(t.close * t.volume) FROM (
                SELECT e2.close, e2.volume FROM ohlcv_eod e2
                WHERE e2.instrument_id = dp.instrument_id
                ORDER BY e2.time DESC LIMIT 20
            ) t) >= 10000000
        """)
    where_clause = f"WHERE {' AND '.join(filters)}" if filters else ""

    # NOTE: latest close is fetched per-instrument via a correlated subquery that
    # rides the (instrument_id, time DESC) index. The previous implementation
    # computed a ROW_NUMBER() window over the *entire* 7.7M-row ohlcv_eod table on
    # every request (~13s); this scales with the number of matched patterns instead
    # (~0.3s). Keep the ranking expression in sync with base.latest_close.
    query = f"""
        WITH base AS (
            SELECT
                dp.id, dp.timeframe, dp.pattern_type, dp.status, dp.confidence,
                {eff_conf} AS eff_conf,
                dp.detection_time, dp.key_points, dp.target_price, dp.stop_loss,
                dp.image_url, i.symbol AS symbol, i.sector AS sector,
                dp.instrument_id AS instrument_id,
                (
                    SELECT e.close FROM ohlcv_eod e
                    WHERE e.instrument_id = dp.instrument_id
                    ORDER BY e.time DESC LIMIT 1
                ) AS latest_close
            FROM detected_patterns dp
            JOIN instruments i ON i.id = dp.instrument_id
            {where_clause}
        ),
        ranked_patterns AS (
            SELECT
                b.*,
                ROW_NUMBER() OVER (
                    PARTITION BY b.instrument_id
                    ORDER BY
                        CASE WHEN b.target_price IS NULL OR b.latest_close IS NULL OR b.latest_close = 0
                             THEN 0
                             ELSE ABS(b.target_price - b.latest_close) / b.latest_close
                        END DESC,
                        b.confidence DESC,
                        b.detection_time DESC
                ) AS rn
            FROM base b
        ),
        -- Interleave pattern types (best of each type first) so one dominant
        -- type can't monopolise the list; within a type, strongest first.
        diversified AS (
            SELECT rp.*,
                ROW_NUMBER() OVER (
                    PARTITION BY rp.pattern_type
                    ORDER BY rp.eff_conf DESC, rp.detection_time DESC
                ) AS type_rank
            FROM ranked_patterns rp
            WHERE rp.rn = 1
        )
        SELECT * FROM diversified
        ORDER BY type_rank ASC, eff_conf DESC, detection_time DESC
        LIMIT :limit
    """
    result = await db.execute(text(query), params)
    rows = result.mappings().all()

    patterns = []
    for row in rows:
        key_points = row["key_points"]
        if isinstance(key_points, str):
            key_points = json.loads(key_points)
        patterns.append(PatternOut(
            id=row["id"],
            symbol=row["symbol"],
            sector=row["sector"],
            timeframe=row["timeframe"],
            pattern_type=row["pattern_type"],
            status=row["status"],
            confidence=round(float(row["confidence"]), 2) if row["confidence"] is not None else None,
            detection_time=row["detection_time"],
            key_points=key_points,
            target_price=float(row["target_price"]) if row["target_price"] is not None else None,
            stop_loss=float(row["stop_loss"]) if row["stop_loss"] is not None else None,
            image_url=row["image_url"],
        ))
    scan_cache.set(_ck, patterns)
    await scan_history.record(getattr(_user, "id", None), "screener", _params, patterns)
    return patterns


@router.get("/patterns/{pattern_id}", response_model=PatternOut)
async def get_pattern(
    pattern_id: int,
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    """Fetch a single detected pattern by id (used to overlay it on the chart)."""
    from fastapi import HTTPException

    result = await db.execute(
        text(
            "SELECT dp.id, dp.timeframe, dp.pattern_type, dp.status, dp.confidence, "
            "dp.detection_time, dp.key_points, dp.target_price, dp.stop_loss, "
            "dp.image_url, i.symbol AS symbol, i.sector AS sector "
            "FROM detected_patterns dp JOIN instruments i ON i.id = dp.instrument_id "
            "WHERE dp.id = :id"
        ),
        {"id": pattern_id},
    )
    row = result.mappings().first()
    if not row:
        raise HTTPException(status_code=404, detail="Pattern not found")

    key_points = row["key_points"]
    if isinstance(key_points, str):
        key_points = json.loads(key_points)

    return PatternOut(
        id=row["id"],
        symbol=row["symbol"],
        sector=row["sector"],
        timeframe=row["timeframe"],
        pattern_type=row["pattern_type"],
        status=row["status"],
        confidence=round(float(row["confidence"]), 2) if row["confidence"] is not None else None,
        detection_time=row["detection_time"],
        key_points=key_points,
        target_price=float(row["target_price"]) if row["target_price"] is not None else None,
        stop_loss=float(row["stop_loss"]) if row["stop_loss"] is not None else None,
        image_url=row["image_url"],
    )


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

