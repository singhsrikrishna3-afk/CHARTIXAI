"""Chartix — Market Analytics: Stage Analysis, Market Breadth, RS Leaders, Peers.

Computed from the full EOD table (~2,100 active stocks with enough history) and
the fundamentals snapshot. Everything is universe-level analytics, cached 15 min
(same convention as the reco/360° builders).

Stage Analysis — Weinstein's four stages, daily proxy of the 30-week MA:
    ma150 rising  & price above  → Stage 2 (advancing)
    ma150 falling & price below  → Stage 4 (declining)
    price below, ma not falling  → Stage 1 (basing)
    price above, ma not rising   → Stage 3 (topping / distribution)
    "rising/falling" = ma150 changed more than ±0.4% over the last month.

Market Breadth — per-session counts across the whole EQ universe:
    advances/declines, McClellan oscillator (EMA19−EMA39 of net advances),
    cumulative AD line, new 252-day closing highs/lows, and participation
    (% of stocks above their 20/50/200-DMA).

RS Leaders — the reco engine's IBD-style weighted-return percentile (1–99),
exposed as a screen instead of staying an internal input.

Peers — same-industry comparison on fundamentals + returns.
"""

import time as _time
from bisect import bisect_left

import pandas as pd
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models import User
from app.auth import get_current_user
from app.api.trade_plan import _weighted_return, _universe_returns

router = APIRouter(prefix="/api/market-analytics", tags=["market-analytics"])

_CACHE = {}          # key -> {"ts": float, "data": ...}
_TTL = 900


def _cached(key):
    v = _CACHE.get(key)
    if v and (_time.time() - v["ts"]) < _TTL:
        return v["data"]
    return None


def _put(key, data):
    _CACHE[key] = {"ts": _time.time(), "data": data}
    return data


async def _load_universe(db, days=620):
    """{iid: {"sym","name","industry","mcap","c": [closes...]}} date-aligned per stock."""
    rows = (await db.execute(text(
        "SELECT e.instrument_id, e.time, e.close, i.symbol, i.name, "
        "       f.industry_src, f.market_cap "
        "FROM ohlcv_eod e "
        "JOIN instruments i ON i.id = e.instrument_id "
        "LEFT JOIN fundamentals f ON f.instrument_id = e.instrument_id "
        "WHERE i.is_active = 1 AND i.segment = 'EQ' AND e.close IS NOT NULL "
        f"AND e.time >= date('now','-{int(days)} day') "
        "ORDER BY e.instrument_id, e.time ASC"
    ))).all()
    by = {}
    for iid, t, close, sym, name, ind, mcap in rows:
        d = by.get(iid)
        if d is None:
            d = by[iid] = {"sym": sym, "name": name, "industry": ind or "—",
                           "mcap": float(mcap) if mcap is not None else None,
                           "t": [], "c": []}
        d["t"].append(str(t)[:10])
        d["c"].append(float(close))
    return by


def _stage_of(closes: pd.Series):
    """(stage:int, ma_dist_pct) using the daily proxy of the 30-week MA."""
    if len(closes) < 170:
        return None, None
    ma = closes.rolling(150).mean()
    m_now, m_prev = ma.iloc[-1], ma.iloc[-21]
    if pd.isna(m_now) or pd.isna(m_prev) or m_prev <= 0:
        return None, None
    slope = m_now / m_prev - 1.0
    price = closes.iloc[-1]
    above = price > m_now
    rising, falling = slope > 0.004, slope < -0.004
    if above and rising:
        stage = 2
    elif (not above) and falling:
        stage = 4
    elif not above:
        stage = 1
    else:
        stage = 3
    return stage, float(round((price / m_now - 1) * 100, 1))   # plain float — np.float64 breaks FastAPI JSON


def _mcap_bucket(mcap):
    # INR heuristics: large >= 50k cr, mid >= 15k cr, small below (values in ₹)
    if mcap is None:
        return "unknown"
    cr = mcap / 1e7
    if cr >= 50000: return "large"
    if cr >= 15000: return "mid"
    return "small"


@router.get("/stages")
async def stage_analysis(db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    """Weinstein stage per stock + distribution overall, by market cap, by industry."""
    hit = _cached("stages")
    if hit:
        return hit
    uni = await _load_universe(db)
    rs_dist = await _universe_returns(db)

    stocks = []
    for iid, d in uni.items():
        c = pd.Series(d["c"])
        stage, ma_dist = _stage_of(c)
        if stage is None:
            continue
        wr = _weighted_return(c)
        rs = None
        if wr is not None and rs_dist:
            rs = int(max(1, min(99, round(bisect_left(rs_dist, wr) / len(rs_dist) * 100))))
        stocks.append({"symbol": d["sym"], "name": d["name"], "industry": d["industry"],
                       "mcap_bucket": _mcap_bucket(d["mcap"]),
                       "stage": stage, "ma_dist_pct": ma_dist, "rs": rs,
                       "price": round(float(c.iloc[-1]), 2)})

    dist = {s: 0 for s in (1, 2, 3, 4)}
    by_mcap = {b: {s: 0 for s in (1, 2, 3, 4)} for b in ("large", "mid", "small", "unknown")}
    by_ind = {}
    for s in stocks:
        dist[s["stage"]] += 1
        by_mcap[s["mcap_bucket"]][s["stage"]] += 1
        bi = by_ind.setdefault(s["industry"], {"n": 0, "stage2": 0})
        bi["n"] += 1
        if s["stage"] == 2:
            bi["stage2"] += 1
    industries = [{"industry": k, "n": v["n"],
                   "stage2_pct": round(v["stage2"] / v["n"] * 100, 1)}
                  for k, v in by_ind.items() if v["n"] >= 5]
    industries.sort(key=lambda x: x["stage2_pct"], reverse=True)

    # top stage-2 leaders first in the stock list; UI can re-filter
    stocks.sort(key=lambda x: (x["stage"] != 2, -(x["rs"] or 0)))
    data = {"universe": len(stocks), "distribution": dist,
            "distribution_pct": {k: round(v / len(stocks) * 100, 1) for k, v in dist.items()},
            "by_mcap": by_mcap, "industries": industries, "stocks": stocks[:400],
            "method": "Daily proxy of Weinstein stages: 150-DMA level & ±0.4%/month slope."}
    return _put("stages", data)


@router.get("/breadth")
async def market_breadth(days: int = Query(120, ge=20, le=250),
                         db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    """Universe-wide breadth series: A/D, McClellan oscillator, AD line, new
    252-day highs/lows, % above 20/50/200-DMA."""
    key = f"breadth:{days}"
    hit = _cached(key)
    if hit:
        return hit
    uni = await _load_universe(db)

    acc = {}   # date -> counters
    for d in uni.values():
        c = pd.Series(d["c"])
        n = len(c)
        if n < 60:
            continue
        chg = c.diff()
        s20 = c.rolling(20).mean(); s50 = c.rolling(50).mean(); s200 = c.rolling(200).mean()
        hi252 = c.rolling(252, min_periods=60).max(); lo252 = c.rolling(252, min_periods=60).min()
        start = max(1, n - days)
        for i in range(start, n):
            a = acc.setdefault(d["t"][i], {"adv": 0, "dec": 0, "n": 0, "a20": 0, "n20": 0,
                                           "a50": 0, "n50": 0, "a200": 0, "n200": 0,
                                           "nh": 0, "nl": 0})
            a["n"] += 1
            if chg.iloc[i] > 0: a["adv"] += 1
            elif chg.iloc[i] < 0: a["dec"] += 1
            if not pd.isna(s20.iloc[i]):
                a["n20"] += 1
                if c.iloc[i] > s20.iloc[i]: a["a20"] += 1
            if not pd.isna(s50.iloc[i]):
                a["n50"] += 1
                if c.iloc[i] > s50.iloc[i]: a["a50"] += 1
            if not pd.isna(s200.iloc[i]):
                a["n200"] += 1
                if c.iloc[i] > s200.iloc[i]: a["a200"] += 1
            if c.iloc[i] >= hi252.iloc[i]: a["nh"] += 1
            if c.iloc[i] <= lo252.iloc[i]: a["nl"] += 1

    dates = sorted(acc)
    # Drop thin sessions (holiday stragglers where only a few instruments have bars)
    if dates:
        med = sorted(acc[d]["n"] for d in dates)[len(dates) // 2]
        dates = [d for d in dates if acc[d]["n"] >= med * 0.5]
    net = pd.Series([acc[d]["adv"] - acc[d]["dec"] for d in dates], dtype=float)
    mccl = (net.ewm(span=19, adjust=False).mean() - net.ewm(span=39, adjust=False).mean())
    ad_line = net.cumsum()

    series = []
    for i, d in enumerate(dates):
        a = acc[d]
        series.append({
            "date": d, "advances": a["adv"], "declines": a["dec"],
            "net": int(net.iloc[i]), "ad_line": int(ad_line.iloc[i]),
            "mcclellan": round(float(mccl.iloc[i]), 1),
            "new_highs": a["nh"], "new_lows": a["nl"],
            "pct_above_20": round(a["a20"] / a["n20"] * 100, 1) if a["n20"] else None,
            "pct_above_50": round(a["a50"] / a["n50"] * 100, 1) if a["n50"] else None,
            "pct_above_200": round(a["a200"] / a["n200"] * 100, 1) if a["n200"] else None,
        })
    data = {"days": len(series), "series": series, "latest": series[-1] if series else None,
            "note": "New highs/lows are 252-session CLOSING extremes; McClellan = EMA19−EMA39 of net advances."}
    return _put(key, data)


@router.get("/rs-leaders")
async def rs_leaders(min_rs: int = Query(80, ge=1, le=99), limit: int = Query(100, ge=10, le=300),
                     db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    """The RS-percentile screen: strongest stocks vs the whole EQ universe."""
    key = f"rs:{min_rs}:{limit}"
    hit = _cached(key)
    if hit:
        return hit
    uni = await _load_universe(db)
    rs_dist = await _universe_returns(db)
    out = []
    for d in uni.values():
        c = pd.Series(d["c"])
        wr = _weighted_return(c)
        if wr is None or not rs_dist:
            continue
        rs = int(max(1, min(99, round(bisect_left(rs_dist, wr) / len(rs_dist) * 100))))
        if rs < min_rs:
            continue
        stage, ma_dist = _stage_of(c)
        r1m = float(round((c.iloc[-1] / c.iloc[-22] - 1) * 100, 1)) if len(c) > 22 else None
        r3m = float(round((c.iloc[-1] / c.iloc[-64] - 1) * 100, 1)) if len(c) > 64 else None
        out.append({"symbol": d["sym"], "name": d["name"], "industry": d["industry"],
                    "rs": rs, "stage": stage, "ma_dist_pct": ma_dist,
                    "ret_1m": r1m, "ret_3m": r3m, "price": round(float(c.iloc[-1]), 2)})
    out.sort(key=lambda x: -x["rs"])
    return _put(key, {"count": len(out[:limit]), "min_rs": min_rs, "leaders": out[:limit]})


@router.get("/peers/{symbol}")
async def peer_comparison(symbol: str, db: AsyncSession = Depends(get_db),
                          user: User = Depends(get_current_user)):
    """Same-industry peers compared on fundamentals + momentum."""
    sym = symbol.upper()
    row = (await db.execute(text(
        "SELECT f.industry_src FROM fundamentals f JOIN instruments i ON i.id=f.instrument_id "
        "WHERE i.symbol = :s"), {"s": sym})).first()
    if not row or not row[0]:
        raise HTTPException(404, f"No industry data for {sym}")
    industry = row[0]

    rows = (await db.execute(text(
        "SELECT i.id, i.symbol, i.name, f.market_cap, f.pe, f.roe, f.profit_margin, "
        "       f.debt_to_equity, f.revenue_growth "
        "FROM fundamentals f JOIN instruments i ON i.id = f.instrument_id "
        "WHERE f.industry_src = :ind AND i.is_active = 1 ORDER BY f.market_cap DESC"),
        {"ind": industry})).all()

    rs_dist = await _universe_returns(db)
    peers = []
    for iid, s, name, mcap, pe, roe, margin, dte, revg in rows[:25]:
        crows = (await db.execute(text(
            "SELECT close FROM ohlcv_eod WHERE instrument_id=:i AND close IS NOT NULL "
            "ORDER BY time DESC LIMIT 300"), {"i": iid})).all()
        c = pd.Series([float(r[0]) for r in reversed(crows)])
        rs = None
        if len(c) >= 64 and rs_dist:
            wr = _weighted_return(c)
            if wr is not None:
                rs = int(max(1, min(99, round(bisect_left(rs_dist, wr) / len(rs_dist) * 100))))
        peers.append({
            "symbol": s, "name": name, "is_self": s == sym,
            "mcap_cr": round(mcap / 1e7, 0) if mcap else None,
            "pe": pe, "roe": roe, "margin": margin, "dte": dte, "rev_growth": revg,
            "rs": rs,
            "ret_3m": float(round((c.iloc[-1] / c.iloc[-64] - 1) * 100, 1)) if len(c) > 64 else None,
        })
    return {"symbol": sym, "industry": industry, "count": len(peers), "peers": peers}
