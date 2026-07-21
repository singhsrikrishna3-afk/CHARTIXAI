"""Chartix — Swing Trade Plan Generator.

For any symbol, produces one actionable swing-trading plan that fuses things
generic charting tools keep separate:

  • ATR-based risk management  → volatility-aware stop, not a round number
  • Position sizing            → exact shares for a chosen ₹ risk / % of capital
  • R-multiple targets         → 1R / 2R / 3R with reward:risk
  • Relative Strength rating   → weighted return vs the whole NSE universe (1–99)
  • Trend health               → SMA stack + distance from 50-DMA
  • AI agreement               → does the proprietary LSTM 5-day forecast confirm?

Read-only, EOD-based. Never places orders.
"""

import logging
from datetime import date

import numpy as np
import pandas as pd
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models import Instrument, Forecast, User
from app.auth import get_current_user

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/trade-plan", tags=["trade-plan"])

NIFTY_SYMBOL = "NIFTY_50"

# Weighted lookbacks for the IBD/Minervini-style Relative Strength score.
# Recent performance is weighted 2x the older windows.
RS_WINDOWS = [(63, 2.0), (126, 1.0), (189, 1.0), (252, 1.0)]


async def _load_closes(db, instrument_id, limit=300):
    rows = (await db.execute(
        text(
            "SELECT time, open, high, low, close, volume FROM ohlcv_eod "
            "WHERE instrument_id = :iid AND close IS NOT NULL "
            "ORDER BY time DESC LIMIT :lim"
        ),
        {"iid": instrument_id, "lim": limit},
    )).all()
    if not rows:
        return None
    df = pd.DataFrame(rows, columns=["time", "open", "high", "low", "close", "volume"])
    df = df.iloc[::-1].reset_index(drop=True)
    for c in ("open", "high", "low", "close"):
        df[c] = df[c].astype(float)
    df["volume"] = df["volume"].fillna(0).astype(float)
    return df


def _atr(df, period=14):
    h, l, c = df["high"], df["low"], df["close"]
    prev = c.shift(1)
    tr = pd.concat([h - l, (h - prev).abs(), (l - prev).abs()], axis=1).max(axis=1)
    return tr.rolling(period).mean()


def _weighted_return(closes):
    """IBD-style weighted return; None if not enough history."""
    if len(closes) < 64:
        return None
    total_w, acc = 0.0, 0.0
    last = closes.iloc[-1]
    for lb, w in RS_WINDOWS:
        if len(closes) > lb:
            past = closes.iloc[-lb - 1]
            if past > 0:
                acc += w * (last / past - 1.0)
                total_w += w
    return acc / total_w if total_w else None


# Cache the universe's weighted-return distribution (same for every symbol on a
# given day). Rescanning ~2,000 stocks per request would be far too slow.
import time as _time
_RS_CACHE = {"ts": 0.0, "returns": None}
_RS_TTL = 900  # 15 minutes


async def _universe_returns(db):
    now = _time.time()
    if _RS_CACHE["returns"] is not None and (now - _RS_CACHE["ts"]) < _RS_TTL:
        return _RS_CACHE["returns"]
    # Bound the scan to ~400 calendar days so we read ~500k rows, not millions.
    rows = (await db.execute(
        text(
            "SELECT e.instrument_id, e.close FROM ohlcv_eod e "
            "JOIN instruments i ON i.id = e.instrument_id "
            "WHERE i.is_active = 1 AND i.segment = 'EQ' AND e.close IS NOT NULL "
            "AND e.time >= date('now','-400 day') "
            "ORDER BY e.instrument_id, e.time ASC"
        )
    )).all()
    by_inst = {}
    for iid, close in rows:
        by_inst.setdefault(iid, []).append(float(close))
    rets = []
    for closes in by_inst.values():
        r = _weighted_return(pd.Series(closes))
        if r is not None:
            rets.append(r)
    _RS_CACHE["returns"] = sorted(rets)
    _RS_CACHE["ts"] = now
    return _RS_CACHE["returns"]


async def _rs_rating(db, this_ret):
    """Percentile-rank this stock's weighted return against the EQ universe (1–99)."""
    if this_ret is None:
        return None
    rets = await _universe_returns(db)
    if len(rets) < 20:
        return None
    import bisect
    below = bisect.bisect_left(rets, this_ret)
    pct = below / len(rets) * 100.0
    return int(max(1, min(99, round(pct))))


# ── Auto Swing Recommendations ────────────────────────────────
# Turns the universe scan into concrete trade recommendations: setup type,
# entry (setup-aware trigger/zone), structure+ATR stop, R-multiple targets
# sanity-checked against resistance, an estimated holding duration derived
# from the stock's own volatility, and a 0–100 confidence blend. Quality
# gates (liquidity, max risk, min R:R, min confidence) keep junk out.
_RECO_CACHE = {"ts": 0.0, "rows": None}
_RECO_TTL = 900


# Empirical win-probability table from the historical backtest
# (scripts/backtest_reco.py): maps setup + base-confidence tier to the observed
# P(first target hit before stop) and average R outcome, so live recommendations
# are ranked by real, back-tested probability rather than only a hand-tuned score.
import json as _json, os as _os
_BT_PATH = _os.path.join(_os.path.dirname(__file__), "..", "..", "data", "reco_backtest.json")
_BT_CACHE = {"mtime": None, "table": None}
# Only surface setups whose back-tested first-target win rate beats this floor.
WIN_RATE_FLOOR = 50.0


def _conf_tier(base_conf):
    if base_conf >= 80: return "80+"
    if base_conf >= 70: return "70-79"
    if base_conf >= 60: return "60-69"
    return "55-59"


def _load_backtest_table():
    try:
        st = _os.stat(_BT_PATH)
    except OSError:
        return None
    if _BT_CACHE["table"] is not None and _BT_CACHE["mtime"] == st.st_mtime:
        return _BT_CACHE["table"]
    try:
        with open(_BT_PATH) as fh:
            _BT_CACHE["table"] = _json.load(fh)
        _BT_CACHE["mtime"] = st.st_mtime
    except Exception:
        return None
    return _BT_CACHE["table"]


def _attach_probabilities(recos, regime_bucket=None):
    """Assign each reco its empirical win_probability + expectancy_r from the
    backtest table: (setup, confidence tier) -> per-setup -> overall fallback.
    expectancy_r reflects the SCALE-OUT plan (book half at T1, run half to T2)
    when the table provides it, so the card's expectancy matches how we tell users
    to actually trade it.

    REGIME-CONDITIONAL (backtested by regime, scripts/backtest_reco.py):
    the same setup performs very differently by market tape — breakouts win 62%
    in bull tape but only 51.5% in bear; pullback runners go NET NEGATIVE in bear
    despite a 63% win rate. So when the table has a (setup|regime) cell with
    enough samples, the tier probability is shifted by that setup's measured
    regime delta, and expectancy comes from the regime cell — making the floors
    downstream act on regime-honest numbers instead of all-tape averages."""
    bt = _load_backtest_table()
    for r in recos:
        p = er = None
        if bt:
            tier = _conf_tier(r.get("base_conf", r["confidence"]))
            cell = (bt.get("by_setup_conf") or {}).get(f'{r["setup"]}|{tier}')
            if not cell or cell.get("n", 0) < 20:
                cell = (bt.get("by_setup") or {}).get(r["setup"])
            if not cell or cell.get("n", 0) < 20:
                cell = bt.get("overall")
            if cell:
                p = cell.get("win_rate")
                er = cell.get("avg_scale_r", cell.get("avg_r"))

            rcell = (bt.get("by_regime") or {}).get(f'{r["setup"]}|{regime_bucket}') if regime_bucket else None
            scell = (bt.get("by_setup") or {}).get(r["setup"])
            if rcell and scell and rcell.get("n", 0) >= 100 and p is not None:
                delta = rcell["win_rate"] - scell["win_rate"]
                p = max(1.0, min(99.0, p + delta))
                er = rcell.get("avg_scale_r", er)
                if abs(delta) >= 3:
                    r.setdefault("reasons", []).append(
                        f"{'+' if delta > 0 else ''}{delta:.0f}pp win-rate adjustment for current market tape"
                    )
        r["win_probability"] = round(p, 1) if p is not None else None
        r["expectancy_r"] = round(er, 2) if er is not None else None


def _score_setup(c, h, l, vv, meta, rs_dist, ai_up):
    """Pure setup detection + scoring on OHLCV series ENDING at the evaluation
    bar. Returns a recommendation dict or None. Shared by the live scanner and the
    historical backtest so both run identical logic. `base_conf` excludes the AI
    term (no per-day historical forecasts exist) and is used for probability
    bucketing; `confidence` includes AI for display."""
    import bisect
    n = len(c)
    if n < 120:
        return None
    price = float(c.iloc[-1])
    if price <= 5:
        return None
    turnover = float((c.iloc[-20:] * vv.iloc[-20:]).mean())
    if turnover < 1e7:
        return None
    prev = c.shift(1)
    tr = pd.concat([h - l, (h - prev).abs(), (l - prev).abs()], axis=1).max(axis=1)
    atr = float(tr.rolling(14).mean().iloc[-1])
    if pd.isna(atr) or atr <= 0:
        return None

    sma20 = float(c.rolling(20).mean().iloc[-1])
    sma50 = float(c.rolling(50).mean().iloc[-1])
    sma200 = float(c.rolling(200).mean().iloc[-1]) if n >= 200 else None
    tscore = 0
    if price > sma50: tscore += 1
    if sma200 and price > sma200: tscore += 1
    if sma200 and sma50 > sma200: tscore += 1
    if sma20 > sma50: tscore += 1

    delta = c.diff()
    rsi = 100 - 100 / (1 + delta.clip(lower=0).rolling(14).mean() /
                       (-delta.clip(upper=0)).rolling(14).mean().replace(0, 1e-9))
    rv = float(rsi.iloc[-1]) if not pd.isna(rsi.iloc[-1]) else 50.0

    hi60 = float(h.iloc[-60:].max())
    hi252 = float(h.iloc[-252:].max())
    dd52 = (hi252 - price) / hi252 * 100 if hi252 else 100
    v5, v20 = float(vv.iloc[-5:].mean()), float(vv.iloc[-20:].mean())
    vol_expand = v20 > 0 and v5 > 1.15 * v20
    chg = c.diff()
    up_vol = float(vv[chg > 0].iloc[-20:].sum()); dn_vol = float(vv[chg < 0].iloc[-20:].sum())
    higher_low = float(l.iloc[-5:].min()) > float(l.iloc[-10:-5].min())

    rsigs = 0
    if rv > float(rsi.iloc[-6]) and float(rsi.iloc[-11:].min()) < 45: rsigs += 1
    ema20 = c.ewm(span=20, adjust=False).mean()
    if price > float(ema20.iloc[-1]): rsigs += 1
    if price > float(c.iloc[-6]): rsigs += 1
    if higher_low: rsigs += 1

    # Relative-strength percentile (1–99) — computed BEFORE setup selection so it
    # can gate detection. Backtest (16k trades) showed RS is the single strongest
    # quality lever: a bounce or breakout LED BY A RELATIVE-STRENGTH LEADER beats
    # one in a laggard by 3–5pp win rate and materially better expectancy.
    r = _weighted_return(c)
    rs = None
    if r is not None and rs_dist:
        rs = int(max(1, min(99, round(bisect.bisect_left(rs_dist, r) / len(rs_dist) * 100))))

    setup = None; entry = price; entry_note = ""
    near_high = (hi60 - price) / price * 100
    if tscore >= 3 and 0 <= near_high <= 3 and vol_expand and (rs or 0) >= 70:
        # RS>=70: breakouts led by leaders — 64.9% win vs 62.6% ungated (backtest).
        setup = "Breakout"
        entry = round(hi60 * 1.002, 2)
        entry_note = f"Buy above ₹{entry} (60-day high breakout on rising volume, RS {rs})"
    elif tscore >= 3 and 35 <= rv <= 58 and dd52 <= 20 and (abs(price - sma20) / price < 0.02 or abs(price - sma50) / price < 0.02):
        # dd52<=20: pullbacks near the 52w high, not deep in a slide — 66.4% vs 64.8%.
        setup = "Pullback in uptrend"
        entry = price
        entry_note = "Buy near current price — shallow pullback to the 20/50-DMA in an uptrend"
    elif 12 <= dd52 <= 35 and rsigs >= 3 and (rs or 0) >= 70 and vol_expand:
        # RS>=70 + volume expansion: oversold bounces in LEADERS confirmed by volume
        # — 60.2% vs 56.6% for the ungated net (the weakest setup, most in need).
        setup = "Oversold reversal"
        entry = price
        entry_note = f"Buy on strength — oversold leader (RS {rs}) turning up on rising volume"
    if not setup:
        return None

    swing_low = float(l.iloc[-10:].min())
    atr_stop = entry - 2.0 * atr
    stop = swing_low if (swing_low < entry and swing_low >= atr_stop * 0.97) else atr_stop
    stop = min(stop, entry - 0.25 * atr)
    risk = entry - stop
    risk_pct = risk / entry * 100
    if risk <= 0 or risk_pct > 8:
        return None

    # First target booked at 1R: a closer first target is hit far more often, so
    # the recommendation's first-target win rate clears 50% (backtested). Target 2
    # is the runner (up to 3R, capped by the 52-week high) for letting winners run.
    t1 = entry + 1.0 * risk
    t2 = min(entry + 3.0 * risk, hi252 * 0.995) if hi252 > entry * 1.02 else entry + 3.0 * risk
    if t2 <= t1:
        t2 = entry + 2.0 * risk
    rr = round((t2 - entry) / risk, 2)
    if rr < 2:
        return None

    days_to_t2 = (t2 - entry) / (0.5 * atr)
    mult = {"Breakout": 0.8, "Pullback in uptrend": 1.0, "Oversold reversal": 1.25}[setup]
    lo_d = max(3, int(days_to_t2 * mult * 0.7))
    hi_d = max(lo_d + 2, int(days_to_t2 * mult * 1.4))
    if hi_d <= 10:
        hold = f"{lo_d}–{hi_d} trading days"
    else:
        hold = f"{max(1, round(lo_d / 5))}–{max(1, round(hi_d / 5))} weeks"

    # rs already computed above (used to gate setup detection)
    fq = sum([
        1 if (meta["roe"] is not None and meta["roe"] >= 15) else 0,
        1 if (meta["dte"] is not None and meta["dte"] <= 1.0) else 0,
        1 if (meta["margin"] is not None and meta["margin"] >= 8) else 0,
    ])
    base_conf = 0.0
    base_conf += (rs or 50) * 0.25
    base_conf += tscore / 4 * 20
    base_conf += (15 if up_vol > dn_vol * 1.1 else 7 if up_vol > dn_vol else 0)
    base_conf += min(rr, 4) / 4 * 15
    base_conf += fq / 3 * 10
    ai_term = (15 if ai_up else 0 if ai_up is None else -5)
    conf = int(max(0, min(100, round(base_conf + ai_term))))
    if conf < 55:
        return None
    base_conf_i = int(max(0, min(100, round(base_conf))))

    reasons = []
    if rs and rs >= 70: reasons.append(f"RS {rs} — market leader")
    if tscore >= 3: reasons.append("healthy MA stack")
    if vol_expand: reasons.append("volume expanding")
    if up_vol > dn_vol * 1.1: reasons.append("accumulation (up-vol > down-vol)")
    if ai_up: reasons.append("AI 5-day forecast agrees")
    if fq >= 2: reasons.append("solid fundamentals")
    if setup == "Oversold reversal": reasons.append(f"{rsigs}/4 reversal signals, {dd52:.0f}% off high")

    return {
        "symbol": meta["symbol"], "name": meta["name"], "sector": meta["sector"],
        "setup": setup, "confidence": conf, "base_conf": base_conf_i,
        "price": round(price, 2),
        "entry": round(entry, 2), "entry_note": entry_note,
        "stop": round(stop, 2), "stop_pct": round(-risk_pct, 2),
        "target1": round(t1, 2), "target2": round(t2, 2),
        "t1_pct": round((t1 / entry - 1) * 100, 1), "t2_pct": round((t2 / entry - 1) * 100, 1),
        "reward_risk": rr, "risk_per_share": round(risk, 2),
        "holding": hold, "rs": rs, "ai_up": ai_up, "reasons": reasons,
        # Diagnostics — consumed by the backtest for per-feature analysis and by
        # regime gating below; the UI ignores them.
        "_diag": {
            "tscore": tscore, "rsigs": rsigs, "rsi": round(rv, 1),
            "dd52": round(dd52, 1), "near_high": round(near_high, 2),
            "vol_expand": bool(vol_expand),
            "updn": round(up_vol / dn_vol, 2) if dn_vol > 0 else None,
            "higher_low": bool(higher_low),
        },
    }


async def _build_recommendations(db):
    now = _time.time()
    if _RECO_CACHE["rows"] is not None and (now - _RECO_CACHE["ts"]) < _RECO_TTL:
        return _RECO_CACHE["rows"]

    rows = (await db.execute(text(
        "SELECT e.instrument_id, e.high, e.low, e.close, e.volume, "
        "       i.symbol, i.name, i.sector, f.roe, f.debt_to_equity, f.profit_margin "
        "FROM ohlcv_eod e "
        "JOIN instruments i ON i.id = e.instrument_id "
        "LEFT JOIN fundamentals f ON f.instrument_id = e.instrument_id "
        "WHERE i.is_active = 1 AND i.segment = 'EQ' AND e.close IS NOT NULL "
        "AND e.time >= date('now','-370 day') "
        "ORDER BY e.instrument_id, e.time ASC"
    ))).all()

    by, meta = {}, {}
    for iid, high, low, close, vol, sym, name, sector, roe, dte, margin in rows:
        d = by.setdefault(iid, {"h": [], "l": [], "c": [], "v": []})
        d["h"].append(float(high) if high is not None else float(close))
        d["l"].append(float(low) if low is not None else float(close))
        d["c"].append(float(close))
        d["v"].append(float(vol) if vol is not None else 0.0)
        if iid not in meta:
            meta[iid] = {"symbol": sym, "name": name, "sector": sector or "—",
                         "roe": _f(roe), "dte": _f(dte), "margin": _f(margin)}

    # AI forecast direction per instrument (bulk)
    frows = (await db.execute(text(
        "SELECT f.instrument_id, f.predicted_close, f.horizon_day "
        "FROM forecasts f JOIN ("
        "  SELECT instrument_id, MAX(as_of_date) AS mx FROM forecasts GROUP BY instrument_id"
        ") m ON m.instrument_id = f.instrument_id AND m.mx = f.as_of_date"
    ))).all()
    latest_pred = {}
    for iid, pc, hd in frows:
        cur = latest_pred.get(iid)
        if cur is None or hd > cur[0]:
            latest_pred[iid] = (hd, float(pc))

    rs_dist = await _universe_returns(db)

    recos = []
    for iid, d in by.items():
        c = pd.Series(d["c"]); h = pd.Series(d["h"]); l = pd.Series(d["l"]); vv = pd.Series(d["v"])
        ai_up = None
        if iid in latest_pred:
            ai_up = latest_pred[iid][1] > float(c.iloc[-1])
        rec = _score_setup(c, h, l, vv, meta[iid], rs_dist, ai_up)
        if rec:
            rec.pop("_diag", None)   # backtest-only diagnostics — not for the API
            recos.append(rec)

    # Attach empirical win probabilities — conditioned on the CURRENT market
    # regime (bull/mixed/bear from the market-health gauge, same buckets the
    # backtest measured) — then keep ONLY trades that are historically
    # better-than-coin-flip (win rate >= 50%) AND net-positive (expectancy > 0).
    # The expectancy floor matters: bear-tape pullbacks win ~63% yet LOSE money
    # (-0.04R scale-out) — a win rate alone is not a reason to recommend.
    # (When no backtest table is available we can't verify, so we don't filter.)
    try:
        tone = (await _compute_market_regime(db)).get("tone", "neutral")
    except Exception:
        tone = "neutral"
    regime_bucket = {"bull": "bull", "neutral": "mixed", "bear": "bear"}.get(tone, "mixed")
    _attach_probabilities(recos, regime_bucket)
    if _load_backtest_table() is not None:
        recos = [r for r in recos
                 if (r.get("win_probability") or 0) >= WIN_RATE_FLOOR
                 and (r.get("expectancy_r") is None or r["expectancy_r"] > 0)]

    # Rank by win probability (highest first); expectancy then confidence break ties.
    recos.sort(key=lambda x: (
        x.get("win_probability") if x.get("win_probability") is not None else -1.0,
        x.get("expectancy_r") if x.get("expectancy_r") is not None else -9.0,
        x["confidence"],
    ), reverse=True)
    _RECO_CACHE["rows"] = recos[:150]
    _RECO_CACHE["ts"] = now
    return _RECO_CACHE["rows"]


def _balanced_mix(recos, limit):
    """Round-robin across setup types so all three are represented, best-first."""
    from collections import OrderedDict
    buckets = OrderedDict()
    for r in recos:  # recos already sorted by confidence desc
        buckets.setdefault(r["setup"], []).append(r)
    out, i = [], 0
    while len(out) < limit and any(i < len(b) for b in buckets.values()):
        for b in buckets.values():
            if i < len(b):
                out.append(b[i])
                if len(out) >= limit:
                    break
        i += 1
    return out


@router.get("/top/recommendations")
async def auto_recommendations(
    capital: float = Query(100000, gt=0),
    risk_pct: float = Query(1.0, gt=0, le=10),
    sector: str = Query(None),
    index: str = Query(None),
    setup: str = Query(None, description="breakout | pullback | reversal | all"),
    limit: int = Query(24, ge=1, le=40),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Auto-generated swing trade recommendations: setup, entry, stop, targets,
    estimated holding duration and confidence — position-sized per user.
    Ranked by empirical, back-tested win probability (highest first); optionally
    filter to one setup type. REGIME-AWARE: as the market weakens, the win-rate
    bar rises, fewer trades are shown, and position sizing shrinks automatically."""
    recos = await _build_recommendations(db)
    sym_set = await _index_symbol_set(db, index)
    recos = _apply_filters(recos, None if sector in (None, "all") else sector, sym_set)

    # ── Regime adjustments ──
    # The REAL weak-market defenses are (1) a higher back-tested win-rate floor
    # and (2) smaller position size. The detector itself is now RS/quality-gated
    # (see _score_setup), so the qualifying pool is already small and selective
    # — a hard display cap that hides most of a vetted pool is no longer needed
    # and just made "8 of 111" look broken. Show up to the caller's `limit` in
    # every regime; the floor + size multiplier carry the risk discipline.
    #   Risk-On: floor 50, size x1.0 · Mixed: floor 53, size x0.75 ·
    #   Risk-Off: floor 56, size x0.5.
    regime = await _compute_market_regime(db)
    tone = regime.get("tone", "neutral")
    if tone == "bull":
        floor, cap, size_mult = WIN_RATE_FLOOR, limit, 1.0
    elif tone == "bear":
        floor, cap, size_mult = 56.0, limit, 0.5
    else:
        floor, cap, size_mult = 53.0, limit, 0.75
    pre_regime = len(recos)
    if _load_backtest_table() is not None and floor > WIN_RATE_FLOOR:
        recos = [r for r in recos if (r.get("win_probability") or 0) >= floor]

    # ── Earnings Shield: never recommend ENTERING right before results ──
    await _attach_earnings(db, recos)
    pre_earn = len(recos)
    recos = [r for r in recos
             if r.get("earnings_in_days") is None or r["earnings_in_days"] > EARNINGS_EXCLUDE_DAYS]
    earnings_excluded = pre_earn - len(recos)

    # recos arrive pre-sorted by back-tested win probability. Default view shows
    # the highest-probability trades across all setups; the setup filter narrows
    # to one type, still probability-ranked.
    setup_key = (setup or "all").lower()
    setup_names = {"breakout": "Breakout", "pullback": "Pullback in uptrend", "reversal": "Oversold reversal"}

    # The regime cap limits how many trades are SHOWN (a weak-market defense).
    # Facet counts and the setup filter both operate on this SHOWN set, so the
    # pill numbers, the rendered cards, and "View All on Charts" always agree.
    # (Previously counts were over the full pre-cap pool, so "All (88)" appeared
    # beside only 8 shown/chartable trades.) `available_count` still exposes the
    # full qualifying pool so the UI can say "8 of 88 qualifying shown".
    available_count = len(recos)
    shown = recos[:cap]
    counts = {"Breakout": 0, "Pullback in uptrend": 0, "Oversold reversal": 0}
    for r in shown:
        counts[r["setup"]] = counts.get(r["setup"], 0) + 1
    if setup_key in setup_names:
        selected = [r for r in shown if r["setup"] == setup_names[setup_key]]
    else:
        selected = shown

    risk_amount = capital * (risk_pct / 100.0) * size_mult
    out = []
    for r in selected:
        shares = int(risk_amount // r["risk_per_share"]) if r["risk_per_share"] > 0 else 0
        invested = round(shares * r["entry"], 2)
        if invested > capital:
            shares = int(capital // r["entry"]); invested = round(shares * r["entry"], 2)
        out.append({**r, "shares": shares, "invested": invested})
    return {"count": len(out), "available_count": available_count,
            "capital": capital, "risk_pct": risk_pct,
            "risk_amount": round(risk_amount, 2),
            "setup_counts": {"breakout": counts["Breakout"], "pullback": counts["Pullback in uptrend"],
                             "reversal": counts["Oversold reversal"]},
            "regime_adjustments": {
                "tone": tone, "label": regime.get("label"), "score": regime.get("score"),
                "win_rate_floor": floor, "max_shown": cap, "size_multiplier": size_mult,
                "filtered_out": max(0, pre_regime - pre_earn),
            },
            "earnings_shield": {"excluded": earnings_excluded,
                                "exclude_days": EARNINGS_EXCLUDE_DAYS,
                                "warn_days": EARNINGS_WARN_DAYS},
            "results": out}


# ── Earnings Shield ───────────────────────────────────────────
# Earnings gaps are the #1 way swing trades blow up: a clean setup entered two
# days before results is a coin-flip on the report, not a technical trade. The
# earnings_calendar table (populated by scripts/sync_earnings.py, weekly cron)
# holds each stock's next report date; we flag anything reporting soon and drop
# setups that would ENTER right before results.
EARNINGS_EXCLUDE_DAYS = 3    # entering with results ≤3 days out → excluded
EARNINGS_WARN_DAYS = 10      # ≤10 days out → shown but flagged


async def _attach_earnings(db, items):
    """Set earnings_date / earnings_in_days on each item (list of dicts with a
    'symbol' key). Only future dates count; unknown or past dates → None."""
    if not items:
        return
    syms = sorted({i["symbol"] for i in items})
    try:
        rows = (await db.execute(text(
            "SELECT symbol, next_earnings FROM earnings_calendar WHERE symbol IN (%s)"
            % ",".join(f"'{s}'" for s in syms)
        ))).all()
    except Exception:   # table not created yet — feature degrades gracefully
        rows = []
    from datetime import date as _date, datetime as _dt
    today = _date.today()
    nxt = {}
    for sym, d in rows:
        try:
            dd = _dt.strptime(str(d)[:10], "%Y-%m-%d").date()
        except Exception:
            continue
        if dd >= today:
            nxt[sym] = dd
    for i in items:
        d = nxt.get(i["symbol"])
        i["earnings_date"] = d.isoformat() if d else None
        i["earnings_in_days"] = (d - today).days if d else None


# ── Market Regime Gauge ───────────────────────────────────────
# Breakouts pay in strong, broad markets and fail in chop. This measures the
# market's health from breadth (how many stocks are above their own moving
# averages), short-term advance/decline, and the Nifty 50's own trend, then boils
# it to a 0–100 score + a plain "what to do" verdict. Cached 15 min.
_REGIME_CACHE = {"ts": 0.0, "data": None}
_REGIME_TTL = 900


async def _compute_market_regime(db):
    now = _time.time()
    if _REGIME_CACHE["data"] is not None and (now - _REGIME_CACHE["ts"]) < _REGIME_TTL:
        return _REGIME_CACHE["data"]

    as_of = (await db.execute(text("SELECT MAX(time) FROM ohlcv_eod"))).scalar()

    # Breadth across the EQ universe
    rows = (await db.execute(text(
        "SELECT e.instrument_id, e.close FROM ohlcv_eod e "
        "JOIN instruments i ON i.id = e.instrument_id "
        "WHERE i.is_active = 1 AND i.segment = 'EQ' AND e.close IS NOT NULL "
        "AND e.time >= date('now','-320 day') "
        "ORDER BY e.instrument_id, e.time ASC"
    ))).all()
    by = {}
    for iid, close in rows:
        by.setdefault(iid, []).append(float(close))

    n = a50 = a200 = a20 = adv = dec = 0
    for cl in by.values():
        m = len(cl)
        if m < 50:
            continue
        n += 1
        price = cl[-1]
        if price > sum(cl[-50:]) / 50:
            a50 += 1
        if m >= 200 and price > sum(cl[-200:]) / 200:
            a200 += 1
        if m >= 20 and price > sum(cl[-20:]) / 20:
            a20 += 1
        if cl[-1] > cl[-2]:
            adv += 1
        elif cl[-1] < cl[-2]:
            dec += 1

    pct50 = round(a50 / n * 100, 1) if n else 0.0
    pct200 = round(a200 / n * 100, 1) if n else 0.0
    pct20 = round(a20 / n * 100, 1) if n else 0.0
    breadth_pos = round(adv / max(1, adv + dec) * 100, 1)

    # Nifty 50 trend
    ncl = [float(r[0]) for r in (await db.execute(text(
        "SELECT e.close FROM ohlcv_eod e JOIN instruments i ON i.id = e.instrument_id "
        "WHERE i.symbol = 'NIFTY_50' AND e.close IS NOT NULL "
        "AND e.time >= date('now','-320 day') ORDER BY e.time ASC"
    ))).all()]
    nifty = None
    nifty_struct = 50.0
    if len(ncl) >= 200:
        p = ncl[-1]; s50 = sum(ncl[-50:]) / 50; s200 = sum(ncl[-200:]) / 200
        above50, above200, golden = p > s50, p > s200, s50 > s200
        ret20 = round((p / ncl[-21] - 1) * 100, 1) if len(ncl) > 21 else 0.0
        nifty_struct = (40 if above200 else 0) + (30 if above50 else 0) + (30 if golden else 0)
        nifty = {"close": round(p, 1), "above_50dma": above50, "above_200dma": above200,
                 "golden_cross": golden, "ret_20d": ret20}

    # Composite 0–100
    score = round(pct50 * 0.30 + pct200 * 0.25 + breadth_pos * 0.15 + nifty_struct * 0.30)
    if score >= 62:
        label, tone = "Risk-On", "bull"
        note = "Broad, healthy market — breakouts are favored. Trade your setups with normal size."
    elif score >= 45:
        label, tone = "Mixed", "neutral"
        note = "Choppy / two-sided market — be selective. Favor only the strongest names and keep size normal-to-light."
    else:
        label, tone = "Risk-Off", "bear"
        note = "Weak market — most stocks are below their averages. Play defense: fewer trades, smaller size, tighter stops."

    data = {
        "as_of": str(as_of)[:10] if as_of else None,
        "score": score, "label": label, "tone": tone, "note": note,
        "universe": n,
        "pct_above_50dma": pct50, "pct_above_200dma": pct200, "pct_above_20dma": pct20,
        "advancers": adv, "decliners": dec, "breadth_positive_pct": breadth_pos,
        "nifty": nifty,
    }
    _REGIME_CACHE["data"] = data
    _REGIME_CACHE["ts"] = now
    return data


@router.get("/market-regime")
async def market_regime(db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    """Market-health gauge: breadth + advance/decline + Nifty trend → 0–100 score
    and a plain-English 'what to do' verdict for swing setups."""
    return await _compute_market_regime(db)


# ── 360° Multi-Factor Score ───────────────────────────────────
# Grades every stock on three INDEPENDENT pillars, each 0–100:
#   • Technical  — trend stack, momentum, ADX, slope, 52w positioning, structure
#   • Money Flow — OBV, CMF, MFI, up/down volume, accumulation, volume expansion
#   • Fundamental— ROE, debt, margins, growth, valuation
# A stock only makes the "all-round" list if it clears the floor on ALL three —
# strong technically AND accumulating AND fundamentally sound. Cached 15 min.
_S360_CACHE = {"ts": 0.0, "rows": None}
_S360_TTL = 900


def _grade(score):
    if score >= 85: return "A+"
    if score >= 78: return "A"
    if score >= 70: return "B+"
    if score >= 62: return "B"
    if score >= 54: return "C+"
    if score >= 46: return "C"
    return "D"


async def _compute_360_scores(db):
    now = _time.time()
    if _S360_CACHE["rows"] is not None and (now - _S360_CACHE["ts"]) < _S360_TTL:
        return _S360_CACHE["rows"]

    rows = (await db.execute(text(
        "SELECT e.instrument_id, e.high, e.low, e.close, e.volume, "
        "       i.symbol, i.name, i.sector, "
        "       f.roe, f.debt_to_equity, f.profit_margin, f.revenue_growth, "
        "       f.earnings_growth, f.pe, f.promoter_holding "
        "FROM ohlcv_eod e "
        "JOIN instruments i ON i.id = e.instrument_id "
        "LEFT JOIN fundamentals f ON f.instrument_id = e.instrument_id "
        "WHERE i.is_active = 1 AND i.segment = 'EQ' AND e.close IS NOT NULL "
        "AND e.time >= date('now','-370 day') "
        "ORDER BY e.instrument_id, e.time ASC"
    ))).all()

    by = {}
    meta = {}
    for (iid, high, low, close, vol, sym, name, sector,
         roe, dte, margin, rev_g, earn_g, pe, prom) in rows:
        d = by.setdefault(iid, {"h": [], "l": [], "c": [], "v": []})
        d["h"].append(float(high) if high is not None else float(close))
        d["l"].append(float(low) if low is not None else float(close))
        d["c"].append(float(close))
        d["v"].append(float(vol) if vol is not None else 0.0)
        if iid not in meta:
            meta[iid] = {
                "symbol": sym, "name": name, "sector": sector or "—",
                "roe": _f(roe), "dte": _f(dte), "margin": _f(margin),
                "rev_g": _f(rev_g), "earn_g": _f(earn_g), "pe": _f(pe), "prom": _f(prom),
            }

    out = []
    for iid, d in by.items():
        n = len(d["c"])
        if n < 60:
            continue
        c = pd.Series(d["c"]); h = pd.Series(d["h"]); l = pd.Series(d["l"]); vv = pd.Series(d["v"])
        price = float(c.iloc[-1])
        if price <= 0:
            continue

        # ── TECHNICAL (0–100) ──
        t = 0
        sma20 = c.rolling(20).mean().iloc[-1]
        sma50 = c.rolling(50).mean().iloc[-1]
        sma200 = c.rolling(200).mean().iloc[-1] if n >= 200 else np.nan
        if not pd.isna(sma50) and price > sma50: t += 12
        if not pd.isna(sma200) and price > sma200: t += 12
        if not pd.isna(sma50) and not pd.isna(sma200) and sma50 > sma200: t += 12
        if not pd.isna(sma20) and not pd.isna(sma50) and sma20 > sma50: t += 8
        # RSI(14)
        delta = c.diff()
        rsi = 100 - 100 / (1 + delta.clip(lower=0).rolling(14).mean() /
                           (-delta.clip(upper=0)).rolling(14).mean().replace(0, 1e-9))
        rv = rsi.iloc[-1]
        if not pd.isna(rv) and 45 <= rv <= 72: t += 12
        elif not pd.isna(rv) and 40 <= rv < 45: t += 6
        # MACD
        ema12 = c.ewm(span=12, adjust=False).mean(); ema26 = c.ewm(span=26, adjust=False).mean()
        macd = ema12 - ema26; sig = macd.ewm(span=9, adjust=False).mean()
        if macd.iloc[-1] > sig.iloc[-1]: t += 10
        # ADX-lite via directional movement strength (trend presence)
        slope20 = (c.iloc[-1] / c.iloc[-21] - 1) * 100 if n >= 21 else 0
        if slope20 > 0: t += 10
        if slope20 > 5: t += 4
        # 52w positioning: healthy = 5–30% off high (room but strong)
        hi52 = h.iloc[-252:].max() if n >= 60 else h.max()
        off_high = (hi52 - price) / hi52 * 100 if hi52 else 100
        if 0 <= off_high <= 25: t += 8
        # structure: higher low
        if l.iloc[-5:].min() > l.iloc[-10:-5].min(): t += 6
        technical = min(100, t)

        # ── MONEY FLOW (0–100) ──
        mfscore = 0
        # OBV
        obv = ((np.sign(c.diff().fillna(0)) * vv).cumsum())
        if len(obv) > 21 and obv.iloc[-1] > obv.iloc[-21]: mfscore += 18
        # CMF(20)
        rng = (h - l).replace(0, 1e-9)
        mfv = ((c - l) - (h - c)) / rng * vv
        cmf = mfv.iloc[-20:].sum() / vv.iloc[-20:].sum() if vv.iloc[-20:].sum() > 0 else 0
        if cmf > 0.05: mfscore += 18
        elif cmf > 0: mfscore += 9
        # up-day vs down-day volume (20d)
        chg = c.diff()
        up_vol = vv[chg > 0].iloc[-20:].sum() if len(vv) >= 20 else vv[chg > 0].sum()
        dn_vol = vv[chg < 0].iloc[-20:].sum() if len(vv) >= 20 else vv[chg < 0].sum()
        if up_vol > dn_vol * 1.1: mfscore += 16
        elif up_vol > dn_vol: mfscore += 8
        # volume expansion
        v5 = vv.iloc[-5:].mean(); v20 = vv.iloc[-20:].mean()
        if v20 > 0 and v5 > v20: mfscore += 12
        # MFI(14)
        tp = (h + l + c) / 3
        rmf = tp * vv
        pos = rmf.where(tp.diff() > 0, 0.0).rolling(14).sum()
        neg = rmf.where(tp.diff() < 0, 0.0).rolling(14).sum()
        mfi = 100 - 100 / (1 + pos / neg.replace(0, 1e-9))
        mfiv = mfi.iloc[-1]
        if not pd.isna(mfiv) and 45 <= mfiv <= 80: mfscore += 18
        # last up day on above-avg volume (demand)
        if chg.iloc[-1] > 0 and v20 > 0 and vv.iloc[-1] > 1.2 * v20: mfscore += 18
        money_flow = min(100, mfscore)

        # ── FUNDAMENTAL (0–100) ──
        m = meta[iid]
        fscore = 0; fund_known = 0
        if m["roe"] is not None:
            fund_known += 1
            fscore += 22 if m["roe"] >= 15 else (11 if m["roe"] >= 10 else 0)
        if m["dte"] is not None:
            fund_known += 1
            fscore += 20 if m["dte"] <= 0.5 else (10 if m["dte"] <= 1.0 else 0)
        if m["margin"] is not None:
            fund_known += 1
            fscore += 16 if m["margin"] >= 10 else (8 if m["margin"] >= 5 else 0)
        if m["rev_g"] is not None:
            fund_known += 1
            fscore += 14 if m["rev_g"] >= 10 else (7 if m["rev_g"] >= 0 else 0)
        if m["earn_g"] is not None:
            fund_known += 1
            fscore += 14 if m["earn_g"] >= 15 else (7 if m["earn_g"] >= 0 else 0)
        if m["pe"] is not None and m["pe"] > 0:
            fund_known += 1
            fscore += 14 if m["pe"] <= 35 else (7 if m["pe"] <= 60 else 0)
        fundamental = min(100, fscore) if fund_known >= 3 else None

        # ── Overall (require all three fronts) ──
        pillars = [technical, money_flow]
        if fundamental is not None:
            overall = round(technical * 0.38 + money_flow * 0.30 + fundamental * 0.32)
            all_round = technical >= 55 and money_flow >= 50 and fundamental >= 55
        else:
            overall = round(technical * 0.55 + money_flow * 0.45)
            all_round = False  # can't certify all-round without fundamentals

        out.append({
            "symbol": m["symbol"], "name": m["name"], "sector": m["sector"],
            "price": round(price, 2),
            "technical": technical, "money_flow": money_flow, "fundamental": fundamental,
            "overall": overall, "grade": _grade(overall),
            "all_round": all_round,
            "roe": round(m["roe"], 1) if m["roe"] is not None else None,
            "off_high_pct": round(off_high, 1),
        })

    # rank: all-round first, then overall score
    out.sort(key=lambda s: (s["all_round"], s["overall"]), reverse=True)
    top = out[:150]
    _S360_CACHE["rows"] = top
    _S360_CACHE["ts"] = now
    return top


def _f(v):
    return float(v) if v is not None else None


async def _index_symbol_set(db, index):
    """Return the set of member symbols for an index (by symbol or name), or None."""
    if not index or index.lower() in ("all", "none", ""):
        return None
    from app.models import IndexConstituent
    IndexInst = Instrument.__table__.alias("idx_inst")
    rows = (await db.execute(text(
        "SELECT mem.symbol FROM index_constituents ic "
        "JOIN instruments idx ON idx.id = ic.index_id "
        "JOIN instruments mem ON mem.id = ic.instrument_id "
        "WHERE idx.symbol = :ix OR idx.name = :ix"
    ), {"ix": index})).all()
    return {r[0] for r in rows} if rows else set()


def _apply_filters(rows, sector, sym_set):
    out = rows
    if sector and sector.lower() not in ("all", "none", ""):
        s = sector.lower()
        out = [r for r in out if (r.get("sector") or "").lower() == s]
    if sym_set is not None:
        out = [r for r in out if r["symbol"] in sym_set]
    return out


@router.get("/top/360")
async def all_round_360(
    all_round_only: bool = Query(True, description="Only stocks strong on all 3 fronts"),
    sector: str = Query(None),
    index: str = Query(None),
    limit: int = Query(50, ge=1, le=100),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Stocks graded across every front — technical, money flow, and fundamentals.
    The all-round list is the rare set that's strong on all three at once."""
    ranked = await _compute_360_scores(db)
    sym_set = await _index_symbol_set(db, index)
    ranked = _apply_filters(ranked, sector, sym_set)
    total_all_round = sum(1 for r in ranked if r["all_round"])
    if all_round_only:
        ranked = [r for r in ranked if r["all_round"]]
    return {
        "count": min(len(ranked), limit),
        "total_all_round": total_all_round,
        "results": ranked[:limit],
    }


# ── Top Opportunities scanner ─────────────────────────────────
# Ranks the whole EQ universe by a composite that rewards genuine reward:risk
# (room to a natural resistance vs the ATR/structure stop) fused with Relative
# Strength, trend health, fundamentals quality and the AI forecast direction.
# The ranking is identical for everyone on a given EOD day (capital/risk only
# scale position size), so it's computed once and cached.
_TOP_CACHE = {"ts": 0.0, "rows": None}
_TOP_TTL = 900  # 15 minutes


async def _compute_universe_setups(db):
    now = _time.time()
    if _TOP_CACHE["rows"] is not None and (now - _TOP_CACHE["ts"]) < _TOP_TTL:
        return _TOP_CACHE["rows"]

    # One bounded scan: ~1 year of OHLCV for every active EQ stock, joined to
    # its fundamentals snapshot. Enough bars for ATR, SMA50/200 and swing highs.
    rows = (await db.execute(
        text(
            "SELECT e.instrument_id, e.high, e.low, e.close, i.symbol, i.name, i.sector, "
            "       f.roe, f.debt_to_equity, f.profit_margin, f.pe "
            "FROM ohlcv_eod e "
            "JOIN instruments i ON i.id = e.instrument_id "
            "LEFT JOIN fundamentals f ON f.instrument_id = e.instrument_id "
            "WHERE i.is_active = 1 AND i.segment = 'EQ' AND e.close IS NOT NULL "
            "AND e.time >= date('now','-370 day') "
            "ORDER BY e.instrument_id, e.time ASC"
        )
    )).all()

    # Group rows per instrument
    by_inst = {}
    meta = {}
    for iid, high, low, close, sym, name, sector, roe, dte, margin, pe in rows:
        d = by_inst.setdefault(iid, {"h": [], "l": [], "c": []})
        d["h"].append(float(high) if high is not None else float(close))
        d["l"].append(float(low) if low is not None else float(close))
        d["c"].append(float(close))
        if iid not in meta:
            meta[iid] = {
                "symbol": sym, "name": name, "sector": sector or "—",
                "roe": float(roe) if roe is not None else None,
                "dte": float(dte) if dte is not None else None,
                "margin": float(margin) if margin is not None else None,
                "pe": float(pe) if pe is not None else None,
            }

    # Universe RS distribution (reuse the cache)
    rs_dist = await _universe_returns(db)
    import bisect

    def rs_of(closes):
        r = _weighted_return(pd.Series(closes))
        if r is None or not rs_dist:
            return None
        return int(max(1, min(99, round(bisect.bisect_left(rs_dist, r) / len(rs_dist) * 100))))

    # Latest AI forecast direction per instrument (one bulk query)
    ai_dir = {}
    frows = (await db.execute(text(
        "SELECT f.instrument_id, f.predicted_close, f.horizon_day, f.as_of_date "
        "FROM forecasts f JOIN ("
        "  SELECT instrument_id, MAX(as_of_date) AS mx FROM forecasts GROUP BY instrument_id"
        ") m ON m.instrument_id = f.instrument_id AND m.mx = f.as_of_date"
    ))).all()
    latest_pred = {}
    for iid, pc, hd, _asof in frows:
        cur = latest_pred.get(iid)
        if cur is None or hd > cur[0]:
            latest_pred[iid] = (hd, float(pc))

    setups = []
    for iid, d in by_inst.items():
        c = pd.Series(d["c"]); h = pd.Series(d["h"]); l = pd.Series(d["l"])
        n = len(c)
        if n < 60:
            continue
        price = float(c.iloc[-1])
        if price <= 0:
            continue

        # ATR(14)
        prev = c.shift(1)
        tr = pd.concat([h - l, (h - prev).abs(), (l - prev).abs()], axis=1).max(axis=1)
        atr = float(tr.rolling(14).mean().iloc[-1])
        if pd.isna(atr) or atr <= 0:
            atr = price * 0.02

        # Stop: ATR(2x) or last-10 swing low, structure-aware
        atr_stop = price - 2.0 * atr
        swing_low = float(l.iloc[-10:].min())
        stop = swing_low if (swing_low < price and swing_low >= atr_stop * 0.97) else atr_stop
        stop = min(stop, price - 0.25 * atr)
        risk = price - stop
        if risk <= 0:
            continue

        # Target: recent significant resistance (60-day swing high) — the natural
        # place to aim. Setups low in their range have the best reward:risk.
        target = float(h.iloc[-60:].max())
        reward = target - price
        if reward <= 0:
            continue  # already at/above resistance — no room, skip
        rr = reward / risk
        if rr < 1.2:
            continue  # not worth it for a swing

        # Trend health (0–4)
        sma20 = c.rolling(20).mean().iloc[-1]
        sma50 = c.rolling(50).mean().iloc[-1]
        sma200 = c.rolling(200).mean().iloc[-1] if n >= 200 else np.nan
        tscore = 0
        if not pd.isna(sma50) and price > sma50: tscore += 1
        if not pd.isna(sma200) and price > sma200: tscore += 1
        if not pd.isna(sma50) and not pd.isna(sma200) and sma50 > sma200: tscore += 1
        if not pd.isna(sma20) and not pd.isna(sma50) and sma20 > sma50: tscore += 1

        m = meta[iid]
        rs = rs_of(d["c"])

        # Fundamentals quality (0–3)
        fq = 0
        if m["roe"] is not None and m["roe"] >= 15: fq += 1
        if m["dte"] is not None and m["dte"] <= 1.0: fq += 1
        if m["margin"] is not None and m["margin"] >= 8: fq += 1

        # AI direction
        ai_up = None
        if iid in latest_pred:
            ai_up = latest_pred[iid][1] > price

        # ── Composite score ──
        # Reward:risk is the headline (capped at 5 so one outlier can't dominate),
        # then quality gates keep it from surfacing junk with big theoretical R:R.
        score = 0.0
        score += min(rr, 5.0) * 8            # up to 40
        score += (rs or 0) * 0.30            # up to ~30
        score += tscore * 5                  # up to 20
        score += fq * 3                      # up to 9
        if ai_up is True: score += 6
        elif ai_up is False: score -= 4

        setups.append({
            "symbol": m["symbol"], "name": m["name"], "sector": m["sector"],
            "price": round(price, 2),
            "entry": round(price, 2),
            "stop": round(stop, 2),
            "stop_pct": round((stop / price - 1) * 100, 2),
            "target": round(target, 2),
            "target_pct": round((target / price - 1) * 100, 2),
            "risk_per_share": round(risk, 2),
            "reward_risk": round(rr, 2),
            "rs": rs,
            "trend_score": tscore,
            "fund_quality": fq,
            "roe": round(m["roe"], 1) if m["roe"] is not None else None,
            "ai_up": ai_up,
            "score": round(score, 1),
        })

    setups.sort(key=lambda s: s["score"], reverse=True)
    top = setups[:120]  # cache a healthy buffer above the 50 we serve
    _TOP_CACHE["rows"] = top
    _TOP_CACHE["ts"] = now
    return top


@router.get("/top/opportunities")
async def top_opportunities(
    capital: float = Query(100000, gt=0),
    risk_pct: float = Query(1.0, gt=0, le=10),
    sector: str = Query(None),
    index: str = Query(None),
    limit: int = Query(50, ge=1, le=100),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Top swing setups across the whole market, ranked by a reward:risk-led
    composite (RS + trend + fundamentals + AI). Position size applied per-user."""
    ranked = await _compute_universe_setups(db)
    sym_set = await _index_symbol_set(db, index)
    ranked = _apply_filters(ranked, sector, sym_set)
    risk_amount = capital * (risk_pct / 100.0)
    out = []
    for s in ranked[:limit]:
        shares = int(risk_amount // s["risk_per_share"]) if s["risk_per_share"] > 0 else 0
        invested = round(shares * s["price"], 2)
        if invested > capital:
            shares = int(capital // s["price"]); invested = round(shares * s["price"], 2)
        out.append({**s, "shares": shares, "invested": invested})
    return {
        "count": len(out),
        "universe_ranked": len(ranked),
        "capital": capital,
        "risk_pct": risk_pct,
        "risk_amount": round(risk_amount, 2),
        "results": out,
    }


@router.get("/{symbol}")
async def trade_plan(
    symbol: str,
    capital: float = Query(100000, gt=0, description="Trading capital in ₹"),
    risk_pct: float = Query(1.0, gt=0, le=10, description="Risk per trade as % of capital"),
    atr_mult: float = Query(2.0, gt=0.5, le=6, description="ATR multiple for the stop"),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    inst = (await db.execute(select(Instrument).where(Instrument.symbol == symbol.upper()))).scalar_one_or_none()
    if not inst:
        raise HTTPException(status_code=404, detail="Symbol not found")

    df = await _load_closes(db, inst.id)
    if df is None or len(df) < 60:
        raise HTTPException(status_code=422, detail="insufficient_history")

    close = df["close"]
    price = float(close.iloc[-1])
    atr = _atr(df)
    atr_val = float(atr.iloc[-1]) if not pd.isna(atr.iloc[-1]) else price * 0.02

    # ── Stops: ATR stop vs recent swing low; use the tighter sensible one ──
    atr_stop = price - atr_mult * atr_val
    swing_low = float(df["low"].iloc[-10:].min())
    # prefer the swing low if it sits just under the ATR stop (structure-aware),
    # else the ATR stop
    stop = swing_low if (swing_low < price and swing_low >= atr_stop * 0.97) else atr_stop
    stop = min(stop, price - 0.25 * atr_val)  # never a zero-risk stop
    risk_per_share = price - stop

    # ── Position sizing ──
    risk_amount = capital * (risk_pct / 100.0)
    shares = int(risk_amount // risk_per_share) if risk_per_share > 0 else 0
    invested = round(shares * price, 2)
    # cap at capital
    if invested > capital:
        shares = int(capital // price)
        invested = round(shares * price, 2)

    # ── R-multiple targets ──
    targets = [round(price + m * risk_per_share, 2) for m in (1, 2, 3)]
    rr_at_t2 = round((targets[1] - price) / risk_per_share, 2) if risk_per_share else None

    # ── Trend health ──
    sma20 = float(close.rolling(20).mean().iloc[-1]) if len(close) >= 20 else None
    sma50 = float(close.rolling(50).mean().iloc[-1]) if len(close) >= 50 else None
    sma200 = float(close.rolling(200).mean().iloc[-1]) if len(close) >= 200 else None
    trend_notes = []
    trend_score = 0
    if sma50 and price > sma50:
        trend_score += 1; trend_notes.append("above 50-DMA")
    if sma200 and price > sma200:
        trend_score += 1; trend_notes.append("above 200-DMA")
    if sma50 and sma200 and sma50 > sma200:
        trend_score += 1; trend_notes.append("50-DMA > 200-DMA")
    if sma20 and sma50 and sma20 > sma50:
        trend_score += 1; trend_notes.append("20-DMA > 50-DMA")
    dist_50 = round((price / sma50 - 1) * 100, 1) if sma50 else None

    # ── Relative Strength rating ──
    this_ret = _weighted_return(close)
    rs = await _rs_rating(db, this_ret)

    # ── AI agreement (existing LSTM forecast) ──
    ai = None
    latest_date = (await db.execute(
        select(Forecast.as_of_date).where(Forecast.instrument_id == inst.id)
        .order_by(Forecast.as_of_date.desc()).limit(1)
    )).scalar_one_or_none()
    if latest_date is not None:
        frows = (await db.execute(
            select(Forecast).where(Forecast.instrument_id == inst.id, Forecast.as_of_date == latest_date)
            .order_by(Forecast.horizon_day.asc())
        )).scalars().all()
        if frows:
            last_pred = float(frows[-1].predicted_close)
            exp_move = round((last_pred / price - 1) * 100, 2)
            ai = {
                "as_of": str(latest_date),
                "horizon_days": len(frows),
                "predicted_close": round(last_pred, 2),
                "expected_move_pct": exp_move,
                "direction": "up" if exp_move > 0 else "down",
                "agrees_with_long": exp_move > 0,
            }

    # ── Overall verdict ──
    reasons = []
    verdict_score = 0
    if trend_score >= 3:
        verdict_score += 2; reasons.append("healthy uptrend")
    elif trend_score >= 2:
        verdict_score += 1
    if rs is not None and rs >= 70:
        verdict_score += 2; reasons.append(f"strong RS ({rs})")
    elif rs is not None and rs >= 50:
        verdict_score += 1
    if ai and ai["agrees_with_long"]:
        verdict_score += 1; reasons.append("AI forecast up")
    if rr_at_t2 and rr_at_t2 >= 2:
        verdict_score += 1; reasons.append(f"{rr_at_t2}:1 reward at T2")

    if verdict_score >= 5:
        verdict = "Strong Setup"
    elif verdict_score >= 3:
        verdict = "Watch"
    else:
        verdict = "Weak / Avoid"

    return {
        "symbol": inst.symbol,
        "name": inst.name,
        "sector": inst.sector or "—",
        "as_of": str(df["time"].iloc[-1]).split("T")[0] if "time" in df else str(date.today()),
        "price": round(price, 2),
        "atr": round(atr_val, 2),
        "plan": {
            "entry": round(price, 2),
            "stop": round(stop, 2),
            "stop_pct": round((stop / price - 1) * 100, 2),
            "risk_per_share": round(risk_per_share, 2),
            "targets": targets,
            "target_labels": ["1R", "2R", "3R"],
            "reward_risk_t2": rr_at_t2,
            "shares": shares,
            "invested": invested,
            "risk_amount": round(risk_amount, 2),
            "capital": capital,
            "risk_pct": risk_pct,
            "atr_mult": atr_mult,
        },
        "trend": {
            "score": trend_score,
            "of": 4,
            "notes": trend_notes,
            "dist_from_50dma_pct": dist_50,
        },
        "relative_strength": rs,
        "ai_forecast": ai,
        "verdict": verdict,
        "verdict_reasons": reasons,
    }
