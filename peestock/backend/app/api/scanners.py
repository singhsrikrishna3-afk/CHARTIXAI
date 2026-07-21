"""PEESTOCK — Custom Scanners CRUD API."""

from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select, desc
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models import CustomScanner, User
from app.schemas import ScannerCreate, ScannerOut
from app.auth import get_current_user

router = APIRouter(prefix="/api/scanners", tags=["scanners"])


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
    return [ScannerOut.model_validate(s) for s in result.scalars().all()]


@router.post("/", response_model=ScannerOut, status_code=201)
async def create_scanner(
    body: ScannerCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Create a new custom scanner."""
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


@router.post("/{scanner_id}/run")
async def run_scanner_endpoint(
    scanner_id: UUID,
    limit: int = Query(50, le=200),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Execute a scanner and return matching symbols."""
    import pandas as pd
    from app.services.scanner_engine import run_scanner

    result = await db.execute(
        select(CustomScanner).where(CustomScanner.id == scanner_id)
    )
    scanner = result.scalar_one_or_none()
    if not scanner:
        raise HTTPException(status_code=404, detail="Scanner not found")

    # Get all active instruments
    from app.models import Instrument, OhlcvEod
    from sqlalchemy import text as sql_text

    instruments = (await db.execute(
        select(Instrument).where(Instrument.is_active == True).limit(500)
    )).scalars().all()

    matches = []
    for instr in instruments:
        # Get last 100 bars for the instrument
        rows = (await db.execute(
            select(OhlcvEod).where(
                OhlcvEod.instrument_id == instr.id
            ).order_by(OhlcvEod.time.desc()).limit(100)
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

        conditions = scanner.conditions
        logic = scanner.logic

        if run_scanner(df, conditions, logic):
            matches.append({
                "symbol": instr.symbol,
                "name": instr.name,
                "close": float(df.iloc[-1]["close"]),
                "volume": int(df.iloc[-1]["volume"]),
            })

        if len(matches) >= limit:
            break

    return {"scanner_id": str(scanner_id), "matches": matches, "count": len(matches)}
