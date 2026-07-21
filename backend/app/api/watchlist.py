"""PEESTOCK — Personal Watchlist API."""

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models import Instrument, WatchlistItem, User
from app.schemas import WatchlistItemOut
from app.auth import get_current_user

router = APIRouter(prefix="/api/watchlist", tags=["watchlist"])


@router.get("/", response_model=list[WatchlistItemOut])
async def get_my_watchlist(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    rows = (await db.execute(
        select(WatchlistItem, Instrument)
        .join(Instrument, Instrument.id == WatchlistItem.instrument_id)
        .where(WatchlistItem.user_id == user.id)
        .order_by(WatchlistItem.added_at.desc())
    )).all()

    if not rows:
        return []

    instrument_ids = [inst.id for _, inst in rows]
    placeholders = ", ".join(str(int(i)) for i in instrument_ids)
    price_rows = (await db.execute(text(f"""
        WITH RankedPrices AS (
            SELECT instrument_id, close, volume, time,
                   LAG(close) OVER (PARTITION BY instrument_id ORDER BY time) as prev_close,
                   ROW_NUMBER() OVER (PARTITION BY instrument_id ORDER BY time DESC) as rn
            FROM ohlcv_eod
            WHERE instrument_id IN ({placeholders})
        )
        SELECT instrument_id, close, volume, prev_close FROM RankedPrices WHERE rn = 1
    """))).fetchall()
    price_by_instrument = {r[0]: r for r in price_rows}

    out = []
    for item, inst in rows:
        p = price_by_instrument.get(inst.id)
        price = float(p[1]) if p and p[1] is not None else 0.0
        volume = int(p[2]) if p and p[2] is not None else 0
        prev_close = float(p[3]) if p and p[3] is not None else price
        change = price - prev_close
        change_pct = (change / prev_close * 100) if prev_close else 0.0
        out.append(WatchlistItemOut(
            symbol=inst.symbol,
            name=inst.name,
            sector=inst.sector,
            price=price,
            change=change,
            change_pct=change_pct,
            volume=volume,
            added_at=item.added_at,
        ))
    return out


@router.post("/{symbol}", status_code=201)
async def add_to_watchlist(
    symbol: str,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    inst = (await db.execute(
        select(Instrument).where(Instrument.symbol == symbol.upper())
    )).scalar_one_or_none()
    if not inst:
        raise HTTPException(status_code=404, detail="Symbol not found")

    existing = (await db.execute(
        select(WatchlistItem).where(
            WatchlistItem.user_id == user.id, WatchlistItem.instrument_id == inst.id
        )
    )).scalar_one_or_none()
    if existing:
        return {"status": "already_added"}

    db.add(WatchlistItem(user_id=user.id, instrument_id=inst.id))
    await db.commit()
    return {"status": "added"}


@router.delete("/{symbol}")
async def remove_from_watchlist(
    symbol: str,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    inst = (await db.execute(
        select(Instrument).where(Instrument.symbol == symbol.upper())
    )).scalar_one_or_none()
    if not inst:
        raise HTTPException(status_code=404, detail="Symbol not found")

    item = (await db.execute(
        select(WatchlistItem).where(
            WatchlistItem.user_id == user.id, WatchlistItem.instrument_id == inst.id
        )
    )).scalar_one_or_none()
    if not item:
        raise HTTPException(status_code=404, detail="Not in watchlist")

    await db.delete(item)
    await db.commit()
    return {"status": "removed"}
