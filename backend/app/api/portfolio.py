"""PEESTOCK — Personal Portfolio (manual holdings) API."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models import Instrument, PortfolioPosition, User
from app.schemas import PortfolioPositionCreate, PortfolioPositionOut
from app.auth import get_current_user

router = APIRouter(prefix="/api/portfolio", tags=["portfolio"])


async def _latest_close(db: AsyncSession, instrument_id: int) -> float | None:
    row = (await db.execute(text(
        "SELECT close FROM ohlcv_eod WHERE instrument_id = :iid AND close IS NOT NULL "
        "ORDER BY time DESC LIMIT 1"
    ), {"iid": instrument_id})).fetchone()
    return float(row[0]) if row and row[0] is not None else None


@router.get("/", response_model=list[PortfolioPositionOut])
async def list_positions(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    rows = (await db.execute(
        select(PortfolioPosition, Instrument)
        .join(Instrument, Instrument.id == PortfolioPosition.instrument_id)
        .where(PortfolioPosition.user_id == user.id)
        .order_by(PortfolioPosition.created_at.desc())
    )).all()

    out = []
    for pos, inst in rows:
        quantity = float(pos.quantity)
        buy_price = float(pos.buy_price)
        invested = quantity * buy_price
        current_price = await _latest_close(db, inst.id)
        current_value = current_price * quantity if current_price is not None else None
        pnl = (current_value - invested) if current_value is not None else None
        pnl_pct = (pnl / invested * 100) if pnl is not None and invested else None
        out.append(PortfolioPositionOut(
            id=pos.id,
            symbol=inst.symbol,
            name=inst.name,
            quantity=quantity,
            buy_price=buy_price,
            buy_date=pos.buy_date,
            notes=pos.notes,
            current_price=current_price,
            invested=invested,
            current_value=current_value,
            pnl=pnl,
            pnl_pct=pnl_pct,
            created_at=pos.created_at,
        ))
    return out


@router.post("/", response_model=PortfolioPositionOut, status_code=201)
async def add_position(
    payload: PortfolioPositionCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    inst = (await db.execute(
        select(Instrument).where(Instrument.symbol == payload.symbol.upper())
    )).scalar_one_or_none()
    if not inst:
        raise HTTPException(status_code=404, detail="Symbol not found")

    pos = PortfolioPosition(
        user_id=user.id,
        instrument_id=inst.id,
        quantity=payload.quantity,
        buy_price=payload.buy_price,
        buy_date=payload.buy_date,
        notes=payload.notes,
    )
    db.add(pos)
    await db.commit()
    await db.refresh(pos)

    invested = payload.quantity * payload.buy_price
    current_price = await _latest_close(db, inst.id)
    current_value = current_price * payload.quantity if current_price is not None else None
    pnl = (current_value - invested) if current_value is not None else None
    pnl_pct = (pnl / invested * 100) if pnl is not None and invested else None

    return PortfolioPositionOut(
        id=pos.id, symbol=inst.symbol, name=inst.name, quantity=payload.quantity,
        buy_price=payload.buy_price, buy_date=payload.buy_date, notes=payload.notes,
        current_price=current_price, invested=invested, current_value=current_value,
        pnl=pnl, pnl_pct=pnl_pct, created_at=pos.created_at,
    )


@router.delete("/{position_id}")
async def delete_position(
    position_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    pos = (await db.execute(
        select(PortfolioPosition).where(
            PortfolioPosition.id == position_id, PortfolioPosition.user_id == user.id
        )
    )).scalar_one_or_none()
    if not pos:
        raise HTTPException(status_code=404, detail="Position not found")

    await db.delete(pos)
    await db.commit()
    return {"status": "deleted"}
