"""Chartix — Relative Rotation Graph (RRG).

Plots each security's RS-Ratio (x, relative strength vs a benchmark) against its
RS-Momentum (y, rate of change of that relative strength), both normalised and
centred at 100. The four quadrants:

    Leading    (x>100, y>100)  — strong & still gaining      → green
    Weakening  (x>100, y<100)  — strong but losing steam     → yellow
    Lagging    (x<100, y<100)  — weak & still falling        → red
    Improving  (x<100, y>100)  — weak but turning up         → blue

Securities rotate clockwise Improving → Leading → Weakening → Lagging over time.
The "tail" is the last N periods, so you can see the direction of rotation, not
just the current spot. This is an RRG-style approximation of the JdK RS-Ratio /
RS-Momentum method (the exact StockCharts formula is proprietary).
"""
import logging
from typing import Optional

import numpy as np
import pandas as pd
from fastapi import APIRouter, Depends, Query, HTTPException
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.auth import get_current_user

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/rrg", tags=["rrg"])

# Default universe: the liquid NSE sector indices, benchmarked to NIFTY 50.
SECTOR_INDICES = [
    "NIFTY_BANK", "NIFTY_IT", "NIFTY_AUTO", "NIFTY_PHARMA", "NIFTY_FMCG",
    "NIFTY_METAL", "NIFTY_REALTY", "NIFTY_MEDIA", "NIFTY_PSU_BANK",
    "NIFTY_OIL_GAS", "NIFTY_MIDCAP_100", "NIFTY_SMALLCAP_100",
]
BENCHMARKS = ["NIFTY_50", "NIFTY_100", "NIFTY_200", "NIFTY_500"]


def _quadrant(x, y):
    if x >= 100 and y >= 100:
        return "Leading"
    if x >= 100 and y < 100:
        return "Weakening"
    if x < 100 and y < 100:
        return "Lagging"
    return "Improving"


def _rrg_series(sec: pd.Series, bench: pd.Series, window: int):
    """RS-Ratio and RS-Momentum series (both centred at 100), aligned on dates."""
    df = pd.concat([sec, bench], axis=1, keys=["s", "b"]).dropna()
    if len(df) < window + 5:
        return None
    rs = 100.0 * df["s"] / df["b"]
    # RS-Ratio: z-score of the RS line over the window, centred at 100, lightly smoothed.
    z = (rs - rs.rolling(window).mean()) / rs.rolling(window).std(ddof=0)
    rs_ratio = (100 + z).rolling(3).mean()
    # RS-Momentum: z-score of the RS-Ratio's own change, centred at 100.
    roc = rs_ratio.diff()
    zm = (roc - roc.rolling(window).mean()) / roc.rolling(window).std(ddof=0)
    rs_mom = (100 + zm).rolling(3).mean()
    out = pd.concat([rs_ratio, rs_mom], axis=1, keys=["ratio", "mom"]).dropna()
    return out


@router.get("")
async def relative_rotation(
    benchmark: str = Query("NIFTY_50"),
    symbols: Optional[str] = Query(None, description="Comma-separated; defaults to sector indices"),
    stocks_in: Optional[str] = Query(None, description="Index symbol → plot its constituent stocks (benchmark defaults to that index)"),
    timeframe: str = Query("W", description="W (weekly, standard) or D (daily)"),
    window: int = Query(14, ge=5, le=52, description="Normalisation lookback (periods)"),
    tail: int = Query(8, ge=2, le=20, description="How many periods of tail to return"),
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    """Return each security's RRG tail + current quadrant vs the benchmark.

    Universe: sector indices (default), an explicit `symbols` list, or the
    constituents of `stocks_in` (in which case the benchmark defaults to that
    index — "which stocks are leading within Nifty Bank")."""
    bench = benchmark.upper()
    universe_kind = "sectors"
    if stocks_in:
        # Constituents of an index, benchmarked to that index by default.
        from app.api.scans import _load_all_instruments
        insts = await _load_all_instruments(db, sector=None, index=stocks_in.upper())
        insts = [i for i in insts if getattr(i, "segment", "EQ") == "EQ"]
        universe = [i.symbol for i in insts[:30]]  # cap so the graph stays readable
        if not universe:
            raise HTTPException(status_code=404, detail=f"No constituents found for {stocks_in}.")
        if benchmark == "NIFTY_50":  # caller didn't override → benchmark to the index
            bench = stocks_in.upper()
        universe_kind = "stocks"
    elif symbols:
        universe = [s.strip().upper() for s in symbols.split(",")]
        universe_kind = "custom"
    else:
        universe = SECTOR_INDICES

    # Pull ~4 years of daily closes for benchmark + universe in one query.
    want = list(dict.fromkeys([bench] + universe))
    rows = (await db.execute(text(
        "SELECT i.symbol, i.name, e.time, e.close FROM ohlcv_eod e "
        "JOIN instruments i ON i.id = e.instrument_id "
        "WHERE i.symbol IN (%s) AND e.close IS NOT NULL "
        "AND e.time >= date('now','-1500 day') ORDER BY e.time ASC"
        % ",".join(f"'{s}'" for s in want)
    ))).all()
    if not rows:
        raise HTTPException(status_code=404, detail="No data for the requested symbols.")

    names, series = {}, {}
    data_through = None
    for sym, name, t, close in rows:
        names[sym] = name or sym
        d = str(t)[:10]
        series.setdefault(sym, {})[d] = float(close)
        if data_through is None or d > data_through:
            data_through = d

    def to_series(sym):
        d = series.get(sym)
        if not d:
            return None
        s = pd.Series(d)
        s.index = pd.to_datetime(s.index)
        s = s.sort_index()
        if timeframe.upper() == "W":
            s = s.resample("W-FRI").last().dropna()
        return s

    bench_s = to_series(bench)
    if bench_s is None or len(bench_s) < window + 10:
        raise HTTPException(status_code=400, detail=f"Not enough data for benchmark {bench}.")

    out = []
    for sym in universe:
        if sym == bench:
            continue
        sec_s = to_series(sym)
        if sec_s is None:
            continue
        rr = _rrg_series(sec_s, bench_s, window)
        if rr is None or len(rr) < 2:
            continue
        pts = rr.tail(tail)
        tail_pts = [{"date": d.strftime("%Y-%m-%d"), "x": round(float(r["ratio"]), 2),
                     "y": round(float(r["mom"]), 2)} for d, r in pts.iterrows()]
        cur = tail_pts[-1]
        out.append({
            "symbol": sym, "name": names.get(sym, sym),
            "x": cur["x"], "y": cur["y"],
            "quadrant": _quadrant(cur["x"], cur["y"]),
            "tail": tail_pts,
        })

    # Order by quadrant strength (Leading first) then RS-Ratio.
    q_order = {"Leading": 0, "Weakening": 1, "Improving": 2, "Lagging": 3}
    out.sort(key=lambda o: (q_order[o["quadrant"]], -o["x"]))

    return {
        "benchmark": bench, "benchmark_name": names.get(bench, bench),
        "timeframe": timeframe.upper(), "window": window, "tail": tail,
        "universe_kind": universe_kind,
        "data_through": data_through,          # real last EOD date (honest)
        "securities": out,
    }


@router.get("/options")
async def rrg_options(db: AsyncSession = Depends(get_db), _user=Depends(get_current_user)):
    """Benchmarks, the sector universe, and indices whose constituents can be
    drilled into (for stock-level RRG) — all with display names, for the UI."""
    rows = (await db.execute(text(
        "SELECT symbol, name FROM instruments WHERE segment='IND' AND is_active=1"
    ))).all()
    names = {s: (n or s) for s, n in rows}
    # Curated drill-down set: the broad benchmarks + sector indices whose
    # constituents are worth exploring ("which stocks lead within Nifty Bank").
    from app.api.scans import _load_all_instruments
    drill = []
    for s in ["NIFTY_50", "NIFTY_100", *SECTOR_INDICES]:
        if s not in names:
            continue
        try:
            n = len([i for i in await _load_all_instruments(db, sector=None, index=s)
                     if getattr(i, "segment", "EQ") == "EQ"])
        except Exception:
            n = 0
        if n >= 3:
            drill.append({"symbol": s, "name": names.get(s, s), "count": n})
    return {
        "benchmarks": [{"symbol": b, "name": names.get(b, b)} for b in BENCHMARKS if b in names],
        "sectors": [{"symbol": s, "name": names.get(s, s)} for s in SECTOR_INDICES if s in names],
        "drilldown_indices": drill,
    }
