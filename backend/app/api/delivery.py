"""Chartix — Delivery Money Flow (institutional-conviction proxy).

NSE reports how many traded shares were actually *delivered* (taken home)
vs intraday-flipped. High delivery % = conviction buying/selling, the closest
free proxy for institutional interest.

Endpoints (static routes must precede the /{symbol} catch-all):
  GET /api/delivery/sectors — sector aggregation: volume-weighted delivery %
      recent window vs baseline, price-confirmed signal. "Where is smart money
      moving, and is it buying or dumping?"
  GET /api/delivery/sectors/{sector}/stocks — drill-down: which stocks inside
      the sector carry the delivery change, with per-stock delivery MFI.
  GET /api/delivery/spikes — today's conviction movers: stocks whose delivered
      quantity blew past their own 20-session norm on real liquidity.
  GET /api/delivery/{symbol} — per-stock series: delivery %, delivery-volume
      MFI (standard MFI fed with delivery volume instead of total volume),
      spike ratio, and a summary.
"""
import logging

import numpy as np
import pandas as pd
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import get_current_user
from app.database import get_db

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/delivery", tags=["delivery"])

MFI_PERIOD = 14
SPIKE_RATIO = 1.8          # delivered qty ≥ 1.8× its own 20-session average
MIN_TURNOVER_SECTOR = 1e7  # ₹1 Cr avg daily turnover — drop illiquid noise
MIN_TURNOVER_SPIKES = 5e7  # ₹5 Cr for the market-wide movers list


def _delivery_mfi(df: pd.DataFrame, period: int = MFI_PERIOD) -> pd.Series:
    """MFI computed on delivery volume: 0-100, >80 heavy conviction inflow,
    <20 heavy conviction outflow."""
    tp = (df["high"] + df["low"] + df["close"]) / 3.0
    mf = tp * df["delivery_qty"].astype(float)
    up = mf.where(tp > tp.shift(1), 0.0)
    dn = mf.where(tp < tp.shift(1), 0.0)
    pos = up.rolling(period).sum()
    neg = dn.rolling(period).sum()
    with np.errstate(divide="ignore", invalid="ignore"):
        mfi = 100.0 - 100.0 / (1.0 + pos / neg.replace(0, np.nan))
    return mfi.where(neg > 0, 100.0).where(pos + neg > 0)


def _signal(deliv_change: float, price_change: float) -> str:
    """Price-confirmed read. Rising delivery share means conviction — but
    conviction *in which direction* depends on price."""
    if deliv_change >= 2.0 and price_change >= 0.5:
        return "accumulation"
    if deliv_change >= 2.0 and price_change <= -0.5:
        return "conviction selling"
    if deliv_change <= -2.0:
        return "conviction fading"
    return "neutral"


@router.get("/sectors")
async def sector_delivery(
    recent_days: int = Query(5, ge=2, le=20, description="conviction window"),
    baseline_days: int = Query(20, ge=10, le=60, description="comparison baseline before the window"),
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    """Volume-weighted delivery % per sector, recent window vs the baseline
    before it, with the sector's own price move (median of member-stock
    returns — composition-proof) to tell accumulation from conviction
    selling."""
    rows = (await db.execute(text(
        "SELECT i.sector, i.symbol, e.time, e.close, e.volume, e.delivery_qty "
        "FROM ohlcv_eod e JOIN instruments i ON i.id = e.instrument_id "
        "WHERE i.segment='EQ' AND i.is_active=1 AND i.sector IS NOT NULL "
        "AND e.delivery_qty IS NOT NULL AND e.volume > 0 "
        "AND e.time >= date('now', :lb) "
        "ORDER BY e.time ASC"
    ), {"lb": f"-{(recent_days + baseline_days) * 2 + 10} day"})).all()
    if not rows:
        raise HTTPException(status_code=404, detail="No delivery data yet — sync pending.")

    raw = pd.DataFrame(rows, columns=["sector", "symbol", "time", "close", "volume", "dq"])
    for c in ("close", "volume", "dq"):
        raw[c] = pd.to_numeric(raw[c], errors="coerce")

    # Sector-day delivery share.
    df = raw.groupby(["sector", "time"], as_index=False).agg(dq=("dq", "sum"), v=("volume", "sum"))
    df["pct"] = 100.0 * df["dq"] / df["v"]

    # Sector price move: median of each member's return over the recent window.
    def _stock_ret(g):
        g = g.sort_values("time")
        if len(g) <= recent_days:
            return np.nan
        p0, p1 = float(g["close"].iloc[-(recent_days + 1)]), float(g["close"].iloc[-1])
        return 100.0 * (p1 / p0 - 1.0) if p0 else np.nan
    rets = raw.groupby(["sector", "symbol"]).apply(_stock_ret, include_groups=False)
    sector_ret = rets.groupby(level=0).median()

    out, data_through = [], str(df["time"].max())
    for sector, g in df.groupby("sector"):
        g = g.sort_values("time")
        if len(g) < recent_days + 5:
            continue
        recent = g.tail(recent_days)
        base = g.iloc[-(recent_days + baseline_days):-recent_days]
        if base.empty:
            continue
        r, b = float(recent["pct"].mean()), float(base["pct"].mean())
        price_change = float(sector_ret.get(sector, np.nan))
        if np.isnan(price_change):
            price_change = 0.0
        change = r - b
        out.append({
            "sector": sector,
            "recent_delivery_pct": round(r, 2),
            "baseline_delivery_pct": round(b, 2),
            "change": round(change, 2),
            "price_change_pct": round(price_change, 2),
            "trend": [{"date": str(t), "pct": round(float(p), 2)}
                      for t, p in zip(g["time"].tail(30), g["pct"].tail(30))],
            "signal": _signal(change, price_change),
        })
    out.sort(key=lambda o: -o["change"])
    return {"recent_days": recent_days, "baseline_days": baseline_days,
            "data_through": data_through, "sectors": out}


@router.get("/sectors/{sector}/stocks")
async def sector_stocks(
    sector: str,
    recent_days: int = Query(5, ge=2, le=20),
    baseline_days: int = Query(20, ge=10, le=60),
    limit: int = Query(25, ge=5, le=60),
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    """Which stocks inside a sector carry its delivery change — ranked by the
    shift in their own delivery share, with price move and delivery MFI."""
    lookback = recent_days + baseline_days + MFI_PERIOD + 10
    rows = (await db.execute(text(
        "SELECT i.symbol, i.name, e.time, e.high, e.low, e.close, e.volume, "
        "       e.delivery_qty, e.delivery_per "
        "FROM ohlcv_eod e JOIN instruments i ON i.id = e.instrument_id "
        "WHERE i.segment='EQ' AND i.is_active=1 AND i.sector = :sec "
        "AND e.delivery_qty IS NOT NULL AND e.volume > 0 "
        "AND e.time >= date('now', :lb) ORDER BY e.time ASC"
    ), {"sec": sector, "lb": f"-{lookback * 2} day"})).all()
    if not rows:
        raise HTTPException(status_code=404, detail=f"No delivery data for sector '{sector}'.")

    df = pd.DataFrame(rows, columns=["symbol", "name", "time", "high", "low",
                                     "close", "volume", "delivery_qty", "delivery_per"])
    for c in ("high", "low", "close", "volume", "delivery_qty", "delivery_per"):
        df[c] = pd.to_numeric(df[c], errors="coerce")

    out = []
    for sym, g in df.groupby("symbol"):
        g = g.sort_values("time").reset_index(drop=True)
        if len(g) < recent_days + 10:
            continue
        if float((g["close"] * g["volume"]).tail(20).mean()) < MIN_TURNOVER_SECTOR:
            continue
        recent = g.tail(recent_days)
        base = g.iloc[-(recent_days + baseline_days):-recent_days]
        if base.empty or base["delivery_per"].isna().all():
            continue
        r = float(recent["delivery_per"].mean())
        b = float(base["delivery_per"].mean())
        p0, p1 = float(g["close"].iloc[-(recent_days + 1)]), float(g["close"].iloc[-1])
        price_change = 100.0 * (p1 / p0 - 1.0) if p0 else 0.0
        mfi = _delivery_mfi(g).dropna()
        out.append({
            "symbol": sym, "name": (g["name"].iloc[0] or sym),
            "recent_delivery_pct": round(r, 2),
            "baseline_delivery_pct": round(b, 2),
            "change": round(r - b, 2),
            "price_change_pct": round(price_change, 2),
            "delivery_mfi": round(float(mfi.iloc[-1]), 1) if len(mfi) else None,
            "signal": _signal(r - b, price_change),
        })
    out.sort(key=lambda o: -o["change"])
    return {"sector": sector, "recent_days": recent_days,
            "baseline_days": baseline_days, "stocks": out[:limit]}


@router.get("/spikes")
async def delivery_spikes(
    limit: int = Query(20, ge=5, le=50),
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    """Today's conviction movers: delivered quantity ≥ {SPIKE_RATIO}× the
    stock's own 20-session average, on liquid names. A spike with price up =
    institutional footprint on the buy side; with price down = the exit door."""
    # sector IS NOT NULL doubles as the ETF filter: ETFs never get a sector
    # from the fundamentals sync, and their ~90% "delivery" (creation units)
    # would otherwise flood the list.
    rows = (await db.execute(text(
        "SELECT i.symbol, i.name, i.sector, e.time, e.close, e.volume, "
        "       e.delivery_qty, e.delivery_per "
        "FROM ohlcv_eod e JOIN instruments i ON i.id = e.instrument_id "
        "WHERE i.segment='EQ' AND i.is_active=1 AND i.sector IS NOT NULL "
        "AND i.name NOT LIKE '%ETF%' AND i.name NOT LIKE '%BeES%' "
        "AND e.delivery_qty IS NOT NULL AND e.volume > 0 "
        "AND e.time >= date('now', '-45 day') ORDER BY e.time ASC"
    ))).all()
    if not rows:
        raise HTTPException(status_code=404, detail="No delivery data yet — sync pending.")

    df = pd.DataFrame(rows, columns=["symbol", "name", "sector", "time",
                                     "close", "volume", "delivery_qty", "delivery_per"])
    for c in ("close", "volume", "delivery_qty", "delivery_per"):
        df[c] = pd.to_numeric(df[c], errors="coerce")
    last_day = df["time"].max()

    out = []
    for sym, g in df.groupby("symbol"):
        g = g.sort_values("time").reset_index(drop=True)
        if len(g) < 12 or g["time"].iloc[-1] != last_day:
            continue
        today = g.iloc[-1]
        hist = g.iloc[:-1].tail(20)
        avg_dq = float(hist["delivery_qty"].mean())
        if avg_dq <= 0 or float((g["close"] * g["volume"]).tail(20).mean()) < MIN_TURNOVER_SPIKES:
            continue
        ratio = float(today["delivery_qty"]) / avg_dq
        if ratio < SPIKE_RATIO or (today["delivery_per"] or 0) < 30:
            continue
        prev_close = float(g["close"].iloc[-2])
        out.append({
            "symbol": sym, "name": today["name"] or sym, "sector": today["sector"],
            "close": round(float(today["close"]), 2),
            "price_change_pct": round(100.0 * (float(today["close"]) / prev_close - 1.0), 2) if prev_close else 0.0,
            "delivery_pct": round(float(today["delivery_per"]), 2),
            "spike_ratio": round(ratio, 1),
        })
    out.sort(key=lambda o: -o["spike_ratio"])
    return {"date": str(last_day), "min_ratio": SPIKE_RATIO, "spikes": out[:limit]}


@router.get("/{symbol}")
async def stock_delivery(
    symbol: str,
    days: int = Query(120, ge=30, le=400),
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    """Delivery %, delivery-volume MFI, spike ratio, and a conviction read
    for one stock."""
    rows = (await db.execute(text(
        "SELECT e.time, e.high, e.low, e.close, e.volume, e.delivery_qty, e.delivery_per "
        "FROM ohlcv_eod e JOIN instruments i ON i.id = e.instrument_id "
        "WHERE i.symbol = :sym AND i.segment='EQ' "
        "ORDER BY e.time DESC LIMIT :lim"
    ), {"sym": symbol.upper(), "lim": days + MFI_PERIOD + 5})).all()
    if not rows:
        raise HTTPException(status_code=404, detail=f"No EOD data for {symbol}.")

    df = pd.DataFrame(rows, columns=["time", "high", "low", "close", "volume",
                                     "delivery_qty", "delivery_per"])[::-1].reset_index(drop=True)
    for c in ("high", "low", "close", "volume", "delivery_qty", "delivery_per"):
        df[c] = pd.to_numeric(df[c], errors="coerce")
    have = df.dropna(subset=["delivery_qty"])
    if have.empty:
        raise HTTPException(status_code=404,
                            detail=f"No delivery data for {symbol} yet — sync pending.")

    df["mfi"] = _delivery_mfi(df)
    df = df.tail(days)

    dp = df["delivery_per"].dropna()
    latest_dp = float(dp.iloc[-1]) if len(dp) else None
    avg20 = float(dp.tail(20).mean()) if len(dp) >= 5 else None
    latest_mfi = df["mfi"].dropna()
    latest_mfi = float(latest_mfi.iloc[-1]) if len(latest_mfi) else None

    # Spike ratio: today's delivered qty vs the 20 sessions before it.
    dq = df.dropna(subset=["delivery_qty"])
    spike_ratio = None
    if len(dq) >= 10:
        avg_dq = float(dq["delivery_qty"].iloc[:-1].tail(20).mean())
        if avg_dq > 0:
            spike_ratio = round(float(dq["delivery_qty"].iloc[-1]) / avg_dq, 1)

    if latest_dp is not None and avg20 is not None and latest_mfi is not None:
        if latest_dp > avg20 + 5 and latest_mfi >= 60:
            conviction = "strong accumulation"
        elif latest_mfi >= 60:
            conviction = "money flowing in"
        elif latest_mfi <= 40 and latest_dp > avg20 + 5:
            conviction = "conviction selling"
        elif latest_mfi <= 40:
            conviction = "money flowing out"
        else:
            conviction = "neutral"
    else:
        conviction = "insufficient data"

    return {
        "symbol": symbol.upper(),
        "summary": {
            "delivery_pct": round(latest_dp, 2) if latest_dp is not None else None,
            "delivery_pct_avg20": round(avg20, 2) if avg20 is not None else None,
            "delivery_mfi": round(latest_mfi, 1) if latest_mfi is not None else None,
            "spike_ratio": spike_ratio,
            "is_spike": bool(spike_ratio and spike_ratio >= SPIKE_RATIO),
            "conviction": conviction,
        },
        "series": [
            {"date": str(r.time),
             "delivery_pct": round(float(r.delivery_per), 2) if pd.notna(r.delivery_per) else None,
             "delivery_qty": int(r.delivery_qty) if pd.notna(r.delivery_qty) else None,
             "volume": int(r.volume) if pd.notna(r.volume) else None,
             "mfi": round(float(r.mfi), 1) if pd.notna(r.mfi) else None}
            for r in df.itertuples()
        ],
    }
