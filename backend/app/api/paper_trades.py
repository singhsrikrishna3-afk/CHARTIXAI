"""Chartix — Paper Trading journal.

Open simulated swing trades (from an app recommendation or your own plan) and
have them evaluated against real EOD data: did price hit the target or the stop
after entry, what's the current P&L / R-multiple, how many days held. No money
moves — a risk-free way to test whether a plan actually works.
"""
import logging
import uuid
from datetime import date, datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models import PaperTrade, Instrument, User
from app.auth import get_current_user

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/paper-trades", tags=["paper-trades"])


class OpenTradeBody(BaseModel):
    symbol: str
    direction: str = "long"
    qty: int = 1
    entry_price: float
    entry_date: Optional[str] = None      # YYYY-MM-DD; defaults to today
    stop: Optional[float] = None
    target1: Optional[float] = None
    target2: Optional[float] = None
    setup: Optional[str] = None
    source: str = "manual"
    notes: Optional[str] = None


async def _bars_since(db, symbol, since_date):
    """OHLC bars for symbol on/after since_date, chronological."""
    inst = (await db.execute(select(Instrument).where(Instrument.symbol == symbol.upper()))).scalar_one_or_none()
    if not inst:
        return None, []
    rows = (await db.execute(text(
        "SELECT time, high, low, close FROM ohlcv_eod "
        "WHERE instrument_id = :iid AND time >= :d AND close IS NOT NULL ORDER BY time ASC"
    ), {"iid": inst.id, "d": since_date})).all()
    return inst, rows


def _evaluate(t, rows):
    """Evaluate a paper trade against real bars using the SCALE-OUT plan: book
    half the position at target 1 (ceil half), move the stop on the runner to
    breakeven, and let the runner go to target 2. First-touch wins; if stop and a
    target touch the same bar, assume the stop first (conservative).

    Phases: "open" (pre-T1), "runner" (half booked, runner live), "closed" (both
    legs done). For a fully-closed scale-out we store a single *effective* exit
    price whose P&L equals the blended result, so closed trades render without a
    bar re-fetch. Returns a live-status dict merged onto the row."""
    long = (t.direction or "long") == "long"
    d = 1.0 if long else -1.0
    entry = float(t.entry_price)
    stop = float(t.stop) if t.stop is not None else None
    t1 = float(t.target1) if t.target1 is not None else None
    t2 = float(t.target2) if t.target2 is not None else None
    qty = int(t.qty or 1)
    book_qty = qty - qty // 2      # ceil half — booked at target 1
    run_qty = qty // 2             # floor half — the runner to target 2
    risk_ps = abs(entry - stop) if stop is not None else None

    status = t.status
    phase = t.status               # open | runner | closed (display)
    exit_price = float(t.exit_price) if t.exit_price is not None else None
    exit_reason = t.exit_reason
    exit_date = str(t.exit_date) if t.exit_date else None
    last_close = entry
    days_held = 0
    booked_at_t1 = exit_reason in ("target1", "target2", "t1_then_be")
    total_pnl = None

    def _dt(row):
        return str(row[0]).split("T")[0]

    if t.status == "closed" and t.entry_date and t.exit_date:
        try:
            days_held = max(0, (t.exit_date - t.entry_date).days)
        except Exception:
            days_held = 0

    if t.status == "open" and rows:
        last_close = float(rows[-1][3])
        days_held = len(rows)
        n = len(rows)
        # CLOSING-basis stops: a stop fires only when the day CLOSES beyond it and
        # we exit at that close (the honest cost of a closing stop, vs never being
        # wicked out intraday). Targets stay intraday-touch (limit fill) and are
        # checked first each bar.
        stop_i = t1_i = None
        for i in range(n):
            hi, lo, cl = float(rows[i][1]), float(rows[i][2]), float(rows[i][3])
            if t1 is not None and ((hi >= t1) if long else (lo <= t1)):
                t1_i = i
                break
            if stop is not None and ((cl <= stop) if long else (cl >= stop)):
                stop_i = i
                break

        if stop_i is not None:                      # closed beyond the stop pre-T1
            status = phase = "closed"; exit_reason = "stop"
            exit_price = float(rows[stop_i][3])     # exit at the close, not the stop level
            exit_date = _dt(rows[stop_i])
        elif t1_i is not None:
            booked_at_t1 = True
            booked_pnl = (t1 - entry) * d * book_qty
            if run_qty == 0:                        # qty=1: nothing to run, all at T1
                status = phase = "closed"; exit_reason = "target1"
                exit_price = t1; exit_date = _dt(rows[t1_i])
            else:
                r_px = r_reason = r_i = None
                hi0, lo0 = float(rows[t1_i][1]), float(rows[t1_i][2])
                if t2 is not None and ((hi0 >= t2) if long else (lo0 <= t2)):
                    r_px, r_reason, r_i = t2, "target2", t1_i   # gapped through both (touch)
                else:
                    for k in range(t1_i + 1, n):            # runner: closing breakeven after T1 bar
                        hik, lok, clk = float(rows[k][1]), float(rows[k][2]), float(rows[k][3])
                        if t2 is not None and ((hik >= t2) if long else (lok <= t2)):
                            r_px, r_reason, r_i = t2, "target2", k; break
                        if (clk <= entry) if long else (clk >= entry):
                            r_px, r_reason, r_i = entry, "t1_then_be", k; break
                if r_px is not None:                # runner resolved → fully closed
                    total_pnl = booked_pnl + (r_px - entry) * d * run_qty
                    status = phase = "closed"; exit_reason = r_reason
                    exit_price = entry + d * total_pnl / qty  # effective blended exit
                    exit_date = _dt(rows[r_i])
                else:                               # runner still live
                    phase = "runner"
                    total_pnl = booked_pnl + (last_close - entry) * d * run_qty

    # ── blended P&L ──
    if total_pnl is None:
        ref = exit_price if (status == "closed" and exit_price is not None) else last_close
        total_pnl = (ref - entry) * d * qty
    pnl_pct = (total_pnl / (entry * qty) * 100) if (entry and qty) else 0.0
    r_mult = round(total_pnl / (risk_ps * qty), 2) if risk_ps else None

    return {
        "status": status, "phase": phase, "current_price": round(last_close, 2),
        "exit_price": round(exit_price, 2) if exit_price is not None else None,
        "exit_reason": exit_reason, "exit_date": exit_date,
        "days_held": days_held, "booked_at_t1": booked_at_t1,
        "pnl": round(total_pnl, 2), "pnl_pct": round(pnl_pct, 2), "r_multiple": r_mult,
    }


def _row_dict(t):
    return {
        "id": str(t.id), "symbol": t.symbol, "direction": t.direction, "qty": t.qty,
        "entry_price": float(t.entry_price), "entry_date": str(t.entry_date),
        "stop": float(t.stop) if t.stop is not None else None,
        "target1": float(t.target1) if t.target1 is not None else None,
        "target2": float(t.target2) if t.target2 is not None else None,
        "setup": t.setup, "source": t.source, "notes": t.notes, "status": t.status,
    }


FREE_OPEN_TRADE_CAP = 3


@router.post("/", status_code=201)
async def open_trade(body: OpenTradeBody, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    # Free tier: up to 3 open paper trades (enough to genuinely test the product);
    # any paid tier is unlimited — matches the pricing ladder.
    from app.services.subscription_validator import get_user_tier
    if (await get_user_tier(user, db)) == "free":
        from sqlalchemy import func
        n_open = (await db.execute(
            select(func.count()).select_from(PaperTrade).where(
                PaperTrade.user_id == user.id, PaperTrade.status == "open")
        )).scalar()
        if n_open >= FREE_OPEN_TRADE_CAP:
            raise HTTPException(
                status_code=403,
                detail=f"The free plan allows {FREE_OPEN_TRADE_CAP} open paper trades. "
                       "Close one, or upgrade for unlimited paper trading.")

    inst = (await db.execute(select(Instrument).where(Instrument.symbol == body.symbol.upper()))).scalar_one_or_none()
    if not inst:
        raise HTTPException(status_code=404, detail="Symbol not found")
    ed = datetime.strptime(body.entry_date, "%Y-%m-%d").date() if body.entry_date else date.today()
    t = PaperTrade(
        user_id=user.id, symbol=body.symbol.upper(), direction=body.direction, qty=max(1, body.qty),
        entry_price=body.entry_price, entry_date=ed, stop=body.stop,
        target1=body.target1, target2=body.target2, setup=body.setup,
        source=body.source, notes=body.notes,
    )
    db.add(t); await db.flush(); await db.commit()
    return {"id": str(t.id), "status": "open"}


@router.get("/")
async def list_trades(db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    trades = (await db.execute(
        select(PaperTrade).where(PaperTrade.user_id == user.id).order_by(PaperTrade.created_at.desc())
    )).scalars().all()

    out = []
    changed = False
    # persist any auto-closes we detect so stats stay stable. Closed trades are
    # immutable — skip the bar fetch for them (keeps this fast as history grows).
    for t in trades:
        rows = []
        if t.status == "open":
            _, rows = await _bars_since(db, t.symbol, str(t.entry_date))
        ev = _evaluate(t, rows)
        if t.status == "open" and ev["status"] == "closed":
            t.status = "closed"; t.exit_price = ev["exit_price"]
            t.exit_reason = ev["exit_reason"]
            t.exit_date = datetime.strptime(ev["exit_date"], "%Y-%m-%d").date() if ev["exit_date"] else date.today()
            changed = True
        out.append({**_row_dict(t), **ev})
    if changed:
        await db.commit()

    # Earnings Shield: flag positions holding into a results date
    from app.api.trade_plan import _attach_earnings
    await _attach_earnings(db, out)

    # summary stats over closed trades
    closed = [o for o in out if o["status"] == "closed"]
    wins = [o for o in closed if (o["pnl"] or 0) > 0]
    total_pnl = round(sum(o["pnl"] or 0 for o in out), 2)
    avg_r = round(sum(o["r_multiple"] or 0 for o in closed) / len(closed), 2) if closed else None
    stats = {
        "open": sum(1 for o in out if o["status"] == "open"),
        "closed": len(closed),
        "win_rate": round(len(wins) / len(closed) * 100, 1) if closed else None,
        "avg_r": avg_r,
        "total_pnl": total_pnl,
    }
    return {"stats": stats, "trades": out}


def _as_uuid(trade_id: str) -> uuid.UUID:
    """The id column is a UUID type; a raw string path param makes SQLAlchemy's
    UUID processor call .hex on a str and blow up. Coerce (400 on garbage)."""
    try:
        return uuid.UUID(str(trade_id))
    except (ValueError, AttributeError, TypeError):
        raise HTTPException(status_code=400, detail="Invalid trade id")


@router.post("/{trade_id}/close")
async def close_trade(trade_id: str, price: float = Query(...), db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    tid = _as_uuid(trade_id)
    t = (await db.execute(select(PaperTrade).where(PaperTrade.id == tid, PaperTrade.user_id == user.id))).scalar_one_or_none()
    if not t:
        raise HTTPException(status_code=404, detail="Trade not found")
    t.status = "closed"; t.exit_price = price; t.exit_reason = "manual"; t.exit_date = date.today()
    await db.commit()
    return {"status": "closed"}


@router.delete("/{trade_id}", status_code=204)
async def delete_trade(trade_id: str, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    tid = _as_uuid(trade_id)
    t = (await db.execute(select(PaperTrade).where(PaperTrade.id == tid, PaperTrade.user_id == user.id))).scalar_one_or_none()
    if t:
        await db.delete(t); await db.commit()
