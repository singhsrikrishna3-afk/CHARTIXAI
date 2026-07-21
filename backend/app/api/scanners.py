"""PEESTOCK — Custom Scanners CRUD API."""

from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select, desc
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models import CustomScanner, User
from app.schemas import ScannerCreate, ScannerOut, ScannerPreview
from app.auth import get_current_user

router = APIRouter(prefix="/api/scanners", tags=["scanners"])


from app.schemas import ScannerOut
import uuid
import json
from datetime import datetime

SYSTEM_SCANS = [
    ("Golden Crossover (Long Term Bullish)", "The 50-day Simple Moving Average crosses above the 200-day Simple Moving Average.", '[{"indicator": "sma", "params": {"period": 50}, "operator": "crosses_above", "compare_to": {"indicator": "sma", "params": {"period": 200}}}]', '00000000-0000-4000-8000-000000000001'),
    ("Death Crossover (Long Term Bearish)", "The 50-day Simple Moving Average crosses below the 200-day Simple Moving Average.", '[{"indicator": "sma", "params": {"period": 50}, "operator": "crosses_below", "compare_to": {"indicator": "sma", "params": {"period": 200}}}]', '00000000-0000-4000-8000-000000000002'),
    ("RSI Oversold (Potential Reversal)", "RSI (14) has dropped below 30, signaling an oversold condition.", '[{"indicator": "rsi", "params": {"period": 14}, "operator": "lt", "value": 30}]', '00000000-0000-4000-8000-000000000003'),
    ("RSI Overbought (Potential Pullback)", "RSI (14) has risen above 70, signaling an overbought condition.", '[{"indicator": "rsi", "params": {"period": 14}, "operator": "gt", "value": 70}]', '00000000-0000-4000-8000-000000000004'),
    ("MACD Bullish Crossover", "The MACD line has crossed above its Signal line.", '[{"indicator": "macd", "params": {"fast": 12, "slow": 26, "signal": 9, "component": "macd"}, "operator": "crosses_above", "compare_to": {"indicator": "macd", "params": {"fast": 12, "slow": 26, "signal": 9, "component": "signal"}}}]', '00000000-0000-4000-8000-000000000005'),
    ("Bollinger Band Squeeze Breakout", "Bollinger Bands have tightened (Bandwidth < 0.05), indicating a period of extremely low volatility.", '[{"indicator": "bbands", "params": {"period": 20, "std_dev": 2.0, "component": "bandwidth"}, "operator": "lt", "value": 0.05}]', '00000000-0000-4000-8000-000000000006'),
    ("Supertrend Buy Signal", "Price has crossed above the Supertrend line, giving a fresh buy signal.", '[{"indicator": "supertrend", "params": {"period": 10, "multiplier": 3.0, "component": "trend"}, "operator": "eq", "value": 1}]', '00000000-0000-4000-8000-000000000007'),
    ("ADX Strong Trend Formation", "ADX (14) is greater than 25, confirming the presence of a strong underlying trend.", '[{"indicator": "adx", "params": {"period": 14, "component": "adx"}, "operator": "gt", "value": 25}]', '00000000-0000-4000-8000-000000000008'),
    ("NR7 (Narrow Range 7)", "The stock has formed its narrowest trading range of the last 7 days.", '[{"indicator": "nr7", "params": {}, "operator": "eq", "value": 1}]', '00000000-0000-4000-8000-000000000009'),
    ("Inside Bar Breakout Setup", "The current daily candle is completely contained within the previous day's high-low range.", '[{"indicator": "inside_bar", "params": {}, "operator": "eq", "value": 1}]', '00000000-0000-4000-8000-000000000010'),
    ("Bullish Engulfing Pattern", "A large bullish candle has completely engulfed the previous bearish candle.", '[{"indicator": "engulfing", "params": {}, "operator": "eq", "value": 1}]', '00000000-0000-4000-8000-000000000011'),
    ("Hammer Candlestick", "A hammer candlestick has formed showing aggressive buying at the lows.", '[{"indicator": "hammer", "params": {}, "operator": "eq", "value": 1}]', '00000000-0000-4000-8000-000000000012'),
    ("Strong Gap Up Open", "The stock has gapped up by at least 1% compared to yesterday's high.", '[{"indicator": "gap_up", "params": {"min_percent": 1.0}, "operator": "eq", "value": 1}]', '00000000-0000-4000-8000-000000000013')
]

@router.get("/", response_model=list[ScannerOut])
async def list_scanners(
    include_public: bool = Query(True),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """List user's scanners + optional public scanners."""
    if include_public:
        q = select(CustomScanner).where(
            (CustomScanner.user_id == user.id) | (CustomScanner.is_public == True)
        )
    else:
        q = select(CustomScanner).where(CustomScanner.user_id == user.id)

    q = q.order_by(desc(CustomScanner.created_at))
    result = await db.execute(q)
    user_scanners = [ScannerOut.model_validate(s) for s in result.scalars().all()]

    # Append popular system default scanners directly in the API
    system_scanners = []
    if include_public:
        for s_name, s_desc, s_cond, s_uuid in SYSTEM_SCANS:
            system_scanners.append(ScannerOut(
                id=uuid.UUID(s_uuid),
                user_id=user.id,
                name=s_name,
                description=s_desc,
                conditions=json.loads(s_cond),
                logic="AND",
                is_public=True,
                created_at=datetime.utcnow(),
                updated_at=datetime.utcnow()
            ))

    # To avoid duplicates if they were somehow seeded in the DB
    existing_names = {s.name for s in user_scanners}
    filtered_system_scanners = [s for s in system_scanners if s.name not in existing_names]

    return filtered_system_scanners + user_scanners


@router.post("/", response_model=ScannerOut, status_code=201)
async def create_scanner(
    body: ScannerCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Create a new custom scanner."""
    # Admin bypass: admins have unlimited custom scanners
    is_admin = getattr(user, "is_admin", False)
    
    if is_admin:
        tier = "eod_pro"
    else:
        # Check scanner count limits based on subscription tier
        from app.models import Subscription
        from app.api.subscription import _get_tier_features

        # Get latest active subscription
        sub_res = await db.execute(
            select(Subscription)
            .where(Subscription.user_id == user.id)
            .order_by(Subscription.created_at.desc())
            .limit(1)
        )
        sub = sub_res.scalar_one_or_none()

        tier = "free"
        if sub and sub.status in ("active", "trial"):
            from datetime import datetime, timezone as tz
            expires_at = sub.expires_at
            if expires_at:
                # Handle naive/aware string compatibility
                if isinstance(expires_at, str):
                    try:
                        expires_dt = datetime.strptime(expires_at.split(".")[0], "%Y-%m-%d %H:%M:%S")
                    except Exception:
                        expires_dt = datetime.fromisoformat(expires_at)
                    expires_now = datetime.utcnow()
                else:
                    expires_dt = expires_at
                    expires_now = datetime.now(tz.utc) if expires_at.tzinfo is not None else datetime.utcnow()
                if expires_dt >= expires_now:
                    tier = sub.tier
            else:
                tier = sub.tier

    features = _get_tier_features(tier)
    max_scanners = features.get("max_scanners", 2)

    if max_scanners != -1:
        # Count user's current custom scanners
        from sqlalchemy import func
        count_res = await db.execute(
            select(func.count(CustomScanner.id)).where(CustomScanner.user_id == user.id)
        )
        current_count = count_res.scalar() or 0
        if current_count >= max_scanners:
            raise HTTPException(
                status_code=403,
                detail=f"You have reached the maximum number of custom scanners allowed for your plan ({max_scanners}). Please upgrade to unlock unlimited scanners."
            )

    scanner = CustomScanner(
        user_id=user.id,
        name=body.name,
        description=body.description,
        conditions=[c.model_dump() for c in body.conditions],
        logic=body.logic,
        is_public=body.is_public,
    )
    db.add(scanner)
    await db.flush()
    return ScannerOut.model_validate(scanner)



@router.get("/{scanner_id}", response_model=ScannerOut)
async def get_scanner(
    scanner_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Get a specific scanner by ID."""
    # Check if it's a system scan
    for s_name, s_desc, s_cond, s_uuid in SYSTEM_SCANS:
        if str(scanner_id) == s_uuid:
            return ScannerOut(
                id=uuid.UUID(s_uuid),
                user_id=user.id,
                name=s_name,
                description=s_desc,
                conditions=json.loads(s_cond),
                logic="AND",
                is_public=True,
                created_at=datetime.utcnow(),
                updated_at=datetime.utcnow()
            )

    result = await db.execute(
        select(CustomScanner).where(CustomScanner.id == scanner_id)
    )
    scanner = result.scalar_one_or_none()
    if not scanner:
        raise HTTPException(status_code=404, detail="Scanner not found")
    if scanner.user_id != user.id and not scanner.is_public:
        raise HTTPException(status_code=403, detail="Not authorized")
    return ScannerOut.model_validate(scanner)


@router.put("/{scanner_id}", response_model=ScannerOut)
async def update_scanner(
    scanner_id: UUID,
    body: ScannerCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Update an existing scanner."""
    result = await db.execute(
        select(CustomScanner).where(
            CustomScanner.id == scanner_id, CustomScanner.user_id == user.id
        )
    )
    scanner = result.scalar_one_or_none()
    if not scanner:
        raise HTTPException(status_code=404, detail="Scanner not found or not owned by you")

    scanner.name = body.name
    scanner.description = body.description
    scanner.conditions = [c.model_dump() for c in body.conditions]
    scanner.logic = body.logic
    scanner.is_public = body.is_public
    await db.flush()
    return ScannerOut.model_validate(scanner)


@router.delete("/{scanner_id}", status_code=204)
async def delete_scanner(
    scanner_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Delete a scanner."""
    result = await db.execute(
        select(CustomScanner).where(
            CustomScanner.id == scanner_id, CustomScanner.user_id == user.id
        )
    )
    scanner = result.scalar_one_or_none()
    if not scanner:
        raise HTTPException(status_code=404, detail="Scanner not found")
    await db.delete(scanner)


# Fundamental fields usable as scanner conditions, e.g.
#   {"indicator": "pe", "operator": "lt", "value": 25}
#   {"indicator": "roe", "operator": "gt", "value": 15}
# Percent-style fields are percentages; debt_to_equity is a ratio; market_cap INR.
FUNDAMENTAL_FIELDS = {
    "pe", "forward_pe", "pb", "roe", "debt_to_equity", "dividend_yield", "eps",
    "revenue_growth", "earnings_growth", "profit_margin", "market_cap",
    "promoter_holding", "book_value",
}


def _eval_fund(value, operator, target) -> bool:
    """Compare one fundamental value; missing data never matches."""
    if value is None or target is None:
        return False
    v, t = float(value), float(target)
    if operator in ("gt", "above"):
        return v > t
    if operator in ("lt", "below"):
        return v < t
    if operator in ("gte", "above_or_equal"):
        return v >= t
    if operator in ("lte", "below_or_equal"):
        return v <= t
    if operator == "eq":
        return abs(v - t) < 1e-9
    return False


async def _execute_scan(db, conditions, logic, sector, index, limit):
    """Core scan runner shared by /run and /preview. Returns list of match dicts.

    Conditions may mix technical indicators and fundamental fields (see
    FUNDAMENTAL_FIELDS) — e.g. "RSI < 30 AND roe > 15". Fundamentals are checked
    first (cheap dict lookups) so non-matching instruments skip the OHLCV load.

    Results are memoised for 15 min (keyed by conditions/logic/sector/index/limit)
    since they depend only on market data, not the caller."""
    import pandas as pd
    from app.services.scanner_engine import run_scanner
    from app.services import scan_cache
    from app.models import Instrument, OhlcvEod, IndexConstituent, Fundamentals

    cache_key = scan_cache.make_key("scanner", [conditions, logic, sector, index, limit])
    cached = scan_cache.get(cache_key)
    if cached is not None:
        return cached

    fund_conds = [c for c in conditions if c.get("indicator") in FUNDAMENTAL_FIELDS]
    tech_conds = [c for c in conditions if c.get("indicator") not in FUNDAMENTAL_FIELDS]

    fund_by_instr: dict = {}
    if fund_conds:
        for f in (await db.execute(select(Fundamentals))).scalars().all():
            fund_by_instr[f.instrument_id] = f

    stmt = select(Instrument).where(Instrument.is_active == True, Instrument.segment.in_(["EQ", "COMM", "FOREX", "IND"]))
    if sector and sector.lower() not in ("all", "none", ""):
        stmt = stmt.where(Instrument.sector == sector)
    if index and index.lower() not in ("all", "none", ""):
        stmt = stmt.where(Instrument.id.in_(
            select(IndexConstituent.instrument_id).join(
                Instrument, Instrument.id == IndexConstituent.index_id
            ).where(
                (Instrument.symbol == index) | (Instrument.name == index)
            )
        ))
    instruments = (await db.execute(stmt.limit(500))).scalars().all()

    matches = []
    for instr in instruments:
        # Fundamental leg first — cheap dict lookups, lets AND-scans skip the
        # OHLCV load for instruments that can't match anyway.
        f = fund_by_instr.get(instr.id)
        fund_results = [
            _eval_fund(getattr(f, c["indicator"], None) if f else None,
                       c.get("operator"), c.get("value"))
            for c in fund_conds
        ]
        fund_pass_and = all(fund_results) if fund_conds else True
        fund_pass_or = any(fund_results)
        if logic == "AND" and not fund_pass_and:
            continue
        if logic == "OR" and not tech_conds and not fund_pass_or:
            continue

        # Load 300 bars: a 200-period indicator (SMA200 for a golden cross) needs
        # >200 bars just to produce a non-NaN value, plus headroom for the
        # crossover recency window. At 100 bars every 200-period scan silently
        # returned zero matches.
        rows = (await db.execute(
            select(OhlcvEod).where(
                (OhlcvEod.instrument_id == instr.id) &
                (OhlcvEod.open.is_not(None)) &
                (OhlcvEod.high.is_not(None)) &
                (OhlcvEod.low.is_not(None)) &
                (OhlcvEod.close.is_not(None))
            ).order_by(OhlcvEod.time.desc()).limit(300)
        )).scalars().all()

        if len(rows) < 20:
            continue

        df = pd.DataFrame([{
            "time": r.time,
            "open": float(r.open),
            "high": float(r.high),
            "low": float(r.low),
            "close": float(r.close),
            "volume": int(r.volume or 0),
        } for r in reversed(rows)])

        if logic == "OR":
            passed = fund_pass_or or (bool(tech_conds) and run_scanner(df, tech_conds, "OR"))
        else:
            passed = fund_pass_and and (run_scanner(df, tech_conds, "AND") if tech_conds else True)

        if passed:
            matches.append({
                "symbol": instr.symbol,
                "name": instr.name,
                "sector": instr.sector or "—",
                "close": float(df.iloc[-1]["close"]),
                "volume": int(df.iloc[-1]["volume"]),
            })

        if len(matches) >= limit:
            break

    scan_cache.set(cache_key, matches)
    return matches


@router.post("/preview")
async def preview_scan(
    body: ScannerPreview,
    sector: Optional[str] = Query(None),
    index: Optional[str] = Query(None),
    limit: int = Query(50, le=200),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Run ad-hoc conditions without persisting a scanner (single round-trip)."""
    conditions = [c.model_dump() for c in body.conditions]
    matches = await _execute_scan(db, conditions, body.logic or "AND", sector, index, limit)
    from app.services import scan_history
    await scan_history.record(user.id, "scanner",
        {"conditions": conditions, "logic": body.logic or "AND", "sector": sector, "index": index},
        matches)
    return {"matches": matches, "count": len(matches)}


@router.post("/{scanner_id}/run")
async def run_scanner_endpoint(
    scanner_id: UUID,
    sector: Optional[str] = Query(None),
    index: Optional[str] = Query(None),
    limit: int = Query(50, le=200),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Execute a scanner and return matching symbols."""
    class MockScanner:
        pass

    scanner = None
    # Check if it's a system scan
    for s_name, s_desc, s_cond, s_uuid in SYSTEM_SCANS:
        if str(scanner_id) == s_uuid:
            scanner = MockScanner()
            scanner.conditions = json.loads(s_cond)
            scanner.logic = "AND"
            break

    if not scanner:
        result = await db.execute(
            select(CustomScanner).where(CustomScanner.id == scanner_id)
        )
        scanner = result.scalar_one_or_none()

    if not scanner:
        raise HTTPException(status_code=404, detail="Scanner not found")

    matches = await _execute_scan(db, scanner.conditions, scanner.logic, sector, index, limit)
    from app.services import scan_history
    await scan_history.record(user.id, "scanner",
        {"scanner_id": str(scanner_id), "conditions": scanner.conditions,
         "logic": scanner.logic, "sector": sector, "index": index}, matches)
    return {"scanner_id": str(scanner_id), "matches": matches, "count": len(matches)}
