"""PEESTOCK — Dedicated Scan Endpoints (MA, Indicators, Candlesticks, Other)."""
from __future__ import annotations
import numpy as np
import pandas as pd
from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from app.database import get_db
from app.models import Instrument, OhlcvEod
from app.auth import get_current_user
from app.models import User
from app.services.scanner_engine import (
    compute_sma, compute_ema, compute_rsi, compute_macd,
    compute_supertrend, compute_ichimoku, compute_bbands,
    compute_atr, compute_slope, compute_engulfing,
    compute_hammer, compute_doji,
)

router = APIRouter(prefix="/api/scans", tags=["scans"])

LOOKBACK = 300  # bars to fetch per instrument
MAX_INSTRUMENTS = 2000


async def _load_all_instruments(db: AsyncSession):
    rows = (await db.execute(
        select(Instrument).where(Instrument.is_active == True).limit(MAX_INSTRUMENTS)
    )).scalars().all()
    return rows


async def _load_df(db: AsyncSession, instr_id, limit: int = LOOKBACK) -> pd.DataFrame | None:
    rows = (await db.execute(
        select(OhlcvEod).where(OhlcvEod.instrument_id == instr_id)
        .order_by(OhlcvEod.time.desc()).limit(limit)
    )).scalars().all()
    if len(rows) < 30:
        return None
    df = pd.DataFrame([{
        "time": r.time, "open": float(r.open), "high": float(r.high),
        "low": float(r.low), "close": float(r.close), "volume": int(r.volume or 0),
    } for r in reversed(rows)])
    return df


def _result_row(instr, df: pd.DataFrame, extra: dict = None):
    last = df.iloc[-1]
    prev = df.iloc[-2] if len(df) > 1 else last
    chg = ((last["close"] - prev["close"]) / prev["close"] * 100) if prev["close"] else 0
    row = {
        "symbol": instr.symbol, "name": instr.name,
        "close": round(float(last["close"]), 2),
        "volume": int(last["volume"]),
        "change_pct": round(float(chg), 2),
    }
    if extra:
        row.update(extra)
    return row


# ── MA Scanner ────────────────────────────────────────────────
@router.get("/ma")
async def ma_scanner(
    scan_type: str = Query("crossover"),
    ma_type: str = Query("EMA"),
    period1: int = Query(20),
    period2: int = Query(50),
    period3: int = Query(200),
    direction: str = Query("bullish"),
    timeframe: str = Query("D"),
    rsi_filter: str = Query("none"),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    instruments = await _load_all_instruments(db)
    matches = []

    def get_ma(close: pd.Series, period: int) -> pd.Series:
        if ma_type.upper() == "SMA":
            return compute_sma(close, period)
        elif ma_type.upper() == "WMA":
            weights = np.arange(1, period + 1)
            return close.rolling(period).apply(lambda x: np.dot(x, weights) / weights.sum(), raw=True)
        return compute_ema(close, period)

    for instr in instruments:
        df = await _load_df(db, instr.id)
        if df is None:
            continue
        close = df["close"]
        try:
            ma1 = get_ma(close, period1)
            matched = False

            if scan_type == "crossover":
                ma2 = get_ma(close, period2)
                if direction == "bullish":
                    matched = ma1.iloc[-2] <= ma2.iloc[-2] and ma1.iloc[-1] > ma2.iloc[-1]
                else:
                    matched = ma1.iloc[-2] >= ma2.iloc[-2] and ma1.iloc[-1] < ma2.iloc[-1]

            elif scan_type == "slope":
                slope = compute_slope(ma1, 5)
                matched = slope.iloc[-1] > 0 if direction == "bullish" else slope.iloc[-1] < 0

            elif scan_type == "convergence":
                ma2 = get_ma(close, period2)
                ma3 = get_ma(close, period3)
                gap_now = abs(ma1.iloc[-1] - ma2.iloc[-1]) + abs(ma2.iloc[-1] - ma3.iloc[-1])
                gap_prev = abs(ma1.iloc[-5] - ma2.iloc[-5]) + abs(ma2.iloc[-5] - ma3.iloc[-5])
                matched = gap_now < gap_prev

            elif scan_type == "price_above":
                if direction == "bullish":
                    matched = close.iloc[-1] > ma1.iloc[-1]
                else:
                    matched = close.iloc[-1] < ma1.iloc[-1]

            if not matched:
                continue

            # Optional RSI filter
            if rsi_filter != "none":
                rsi = compute_rsi(close, 14)
                rsi_val = rsi.iloc[-1]
                if rsi_filter == "above_50" and rsi_val <= 50:
                    continue
                elif rsi_filter == "below_50" and rsi_val >= 50:
                    continue
                elif rsi_filter == "above_70" and rsi_val <= 70:
                    continue
                elif rsi_filter == "below_30" and rsi_val >= 30:
                    continue

            matches.append(_result_row(instr, df))
            if len(matches) >= 200:
                break
        except Exception:
            continue

    return {"count": len(matches), "matches": matches}


# ── Indicator Scanner ─────────────────────────────────────────
@router.post("/indicators")
async def indicator_scanner(
    body: dict,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    indicator = body.get("indicator", "supertrend")
    signal = body.get("signal", "buy")
    instruments = await _load_all_instruments(db)
    matches = []

    for instr in instruments:
        df = await _load_df(db, instr.id)
        if df is None:
            continue
        close = df["close"]
        try:
            matched = False
            sig_dir = "bullish"

            if indicator == "supertrend":
                period = body.get("atr_period", 10)
                mult = body.get("multiplier", 3.0)
                st = compute_supertrend(df, period=period, multiplier=mult)
                trend = st["trend"]
                if signal == "buy":
                    matched = trend.iloc[-2] <= 0 and trend.iloc[-1] > 0
                elif signal == "sell":
                    matched = trend.iloc[-2] >= 0 and trend.iloc[-1] < 0
                    sig_dir = "bearish"
                elif signal == "touch":
                    st_line = st["supertrend"]
                    matched = abs(close.iloc[-1] - st_line.iloc[-1]) / close.iloc[-1] < 0.01

            elif indicator == "ichimoku":
                ich = compute_ichimoku(df)
                tenkan, kijun = ich["tenkan"], ich["kijun"]
                sa, sb = ich["senkou_a"], ich["senkou_b"]
                cloud_top = pd.concat([sa, sb], axis=1).max(axis=1)
                cloud_bot = pd.concat([sa, sb], axis=1).min(axis=1)
                if signal == "above_cloud":
                    matched = close.iloc[-1] > cloud_top.iloc[-1]
                elif signal == "below_cloud":
                    matched = close.iloc[-1] < cloud_bot.iloc[-1]; sig_dir = "bearish"
                elif signal == "tk_cross_bullish":
                    matched = tenkan.iloc[-2] <= kijun.iloc[-2] and tenkan.iloc[-1] > kijun.iloc[-1]
                elif signal == "tk_cross_bearish":
                    matched = tenkan.iloc[-2] >= kijun.iloc[-2] and tenkan.iloc[-1] < kijun.iloc[-1]; sig_dir = "bearish"
                elif signal == "cloud_twist":
                    matched = (sa.iloc[-2] <= sb.iloc[-2] and sa.iloc[-1] > sb.iloc[-1]) or \
                              (sa.iloc[-2] >= sb.iloc[-2] and sa.iloc[-1] < sb.iloc[-1])

            elif indicator == "rsi_macd":
                rsi_period = body.get("rsi_period", 14)
                rsi_level = body.get("rsi_level", 50)
                rsi_sig = body.get("rsi_signal", "above_level")
                rsi = compute_rsi(close, rsi_period)
                if rsi_sig == "above_level":
                    matched = rsi.iloc[-1] > rsi_level
                elif rsi_sig == "below_level":
                    matched = rsi.iloc[-1] < rsi_level; sig_dir = "bearish"
                elif rsi_sig == "divergence_pos":
                    price_lower = close.iloc[-1] < close.iloc[-10]
                    rsi_higher = rsi.iloc[-1] > rsi.iloc[-10]
                    matched = price_lower and rsi_higher
                elif rsi_sig == "divergence_neg":
                    matched = close.iloc[-1] > close.iloc[-10] and rsi.iloc[-1] < rsi.iloc[-10]; sig_dir = "bearish"
                elif rsi_sig == "breakout":
                    matched = rsi.iloc[-1] == rsi.iloc[-20:].max()

            elif indicator == "sar":
                st = compute_supertrend(df, period=10, multiplier=3.0)
                trend = st["trend"]
                if signal in ("bullish", "flip_bullish"):
                    if signal == "flip_bullish":
                        matched = trend.iloc[-2] <= 0 and trend.iloc[-1] > 0
                    else:
                        matched = trend.iloc[-1] > 0
                else:
                    sig_dir = "bearish"
                    if signal == "flip_bearish":
                        matched = trend.iloc[-2] >= 0 and trend.iloc[-1] < 0
                    else:
                        matched = trend.iloc[-1] < 0

            elif indicator == "bbands":
                bb = compute_bbands(close, period=body.get("period", 20), std_dev=body.get("std_dev", 2.0))
                bw = bb["bandwidth"]
                if signal == "squeeze_keltner":
                    atr = compute_atr(df, 20)
                    kc_upper = close.rolling(20).mean() + 1.5 * atr
                    kc_lower = close.rolling(20).mean() - 1.5 * atr
                    matched = bb["upper"].iloc[-1] < kc_upper.iloc[-1] and bb["lower"].iloc[-1] > kc_lower.iloc[-1]
                elif signal == "squeeze_200":
                    matched = bw.iloc[-1] == bw.iloc[-200:].min()
                elif signal == "squeeze_both":
                    atr = compute_atr(df, 20)
                    kc_upper = close.rolling(20).mean() + 1.5 * atr
                    kc_lower = close.rolling(20).mean() - 1.5 * atr
                    kc_squeeze = bb["upper"].iloc[-1] < kc_upper.iloc[-1] and bb["lower"].iloc[-1] > kc_lower.iloc[-1]
                    hist_squeeze = bw.iloc[-1] == bw.iloc[-200:].min()
                    matched = kc_squeeze and hist_squeeze
                elif signal == "breakout_up":
                    matched = close.iloc[-1] > bb["upper"].iloc[-1]
                elif signal == "breakout_down":
                    matched = close.iloc[-1] < bb["lower"].iloc[-1]; sig_dir = "bearish"

            elif indicator in ("zigzag", "fibonacci"):
                swing = compute_slope(close, 5)
                if signal == "hh_hl":
                    matched = swing.iloc[-1] > 0 and swing.iloc[-5] > 0
                elif signal == "ll_lh":
                    matched = swing.iloc[-1] < 0 and swing.iloc[-5] < 0; sig_dir = "bearish"
                elif signal in ("first_hh", "slope_up", "in_upper_band"):
                    matched = swing.iloc[-1] > 0
                elif signal in ("first_ll", "slope_down", "in_lower_band"):
                    matched = swing.iloc[-1] < 0; sig_dir = "bearish"

            if matched:
                matches.append(_result_row(instr, df, {"signal_direction": sig_dir}))
                if len(matches) >= 200:
                    break
        except Exception:
            continue

    return {"count": len(matches), "matches": matches}


# ── Candlestick Scanner ───────────────────────────────────────
@router.post("/candlesticks")
async def candlestick_scanner(
    body: dict,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    patterns = set(body.get("patterns", []))
    if not patterns:
        return {"count": 0, "matches": []}

    instruments = await _load_all_instruments(db)
    matches = []

    for instr in instruments:
        df = await _load_df(db, instr.id, limit=50)
        if df is None:
            continue
        o, h, l, c = df["open"], df["high"], df["low"], df["close"]
        body_size = (c - o).abs()
        hl_range = h - l

        detected = None
        try:
            # Single bar
            if "doji" in patterns:
                if body_size.iloc[-1] <= hl_range.iloc[-1] * 0.1:
                    detected = "doji"
            if not detected and "hammer" in patterns:
                ls = min(o.iloc[-1], c.iloc[-1]) - l.iloc[-1]
                us = h.iloc[-1] - max(o.iloc[-1], c.iloc[-1])
                if ls > 2 * body_size.iloc[-1] and us < 0.1 * hl_range.iloc[-1]:
                    detected = "hammer"
            if not detected and "shooting_star" in patterns:
                us = h.iloc[-1] - max(o.iloc[-1], c.iloc[-1])
                if us > 2 * body_size.iloc[-1] and c.iloc[-1] < o.iloc[-1]:
                    detected = "shooting_star"
            if not detected and "marubozu_bullish" in patterns:
                if c.iloc[-1] > o.iloc[-1] and body_size.iloc[-1] > hl_range.iloc[-1] * 0.9:
                    detected = "marubozu_bullish"
            if not detected and "marubozu_bearish" in patterns:
                if c.iloc[-1] < o.iloc[-1] and body_size.iloc[-1] > hl_range.iloc[-1] * 0.9:
                    detected = "marubozu_bearish"
            # Two bar
            if not detected and "engulfing_bullish" in patterns:
                if (c.iloc[-2] < o.iloc[-2] and c.iloc[-1] > o.iloc[-1] and
                        o.iloc[-1] <= c.iloc[-2] and c.iloc[-1] >= o.iloc[-2]):
                    detected = "engulfing_bullish"
            if not detected and "engulfing_bearish" in patterns:
                if (c.iloc[-2] > o.iloc[-2] and c.iloc[-1] < o.iloc[-1] and
                        o.iloc[-1] >= c.iloc[-2] and c.iloc[-1] <= o.iloc[-2]):
                    detected = "engulfing_bearish"
            if not detected and "piercing_line" in patterns:
                mid_prev = (o.iloc[-2] + c.iloc[-2]) / 2
                if (c.iloc[-2] < o.iloc[-2] and c.iloc[-1] > o.iloc[-1] and
                        o.iloc[-1] < c.iloc[-2] and c.iloc[-1] > mid_prev):
                    detected = "piercing_line"
            if not detected and "dark_cloud_cover" in patterns:
                mid_prev = (o.iloc[-2] + c.iloc[-2]) / 2
                if (c.iloc[-2] > o.iloc[-2] and c.iloc[-1] < o.iloc[-1] and
                        o.iloc[-1] > c.iloc[-2] and c.iloc[-1] < mid_prev):
                    detected = "dark_cloud_cover"
            if not detected and "harami_bullish" in patterns:
                if (c.iloc[-2] < o.iloc[-2] and c.iloc[-1] > o.iloc[-1] and
                        c.iloc[-1] < o.iloc[-2] and o.iloc[-1] > c.iloc[-2]):
                    detected = "harami_bullish"
            if not detected and "harami_bearish" in patterns:
                if (c.iloc[-2] > o.iloc[-2] and c.iloc[-1] < o.iloc[-1] and
                        o.iloc[-1] < c.iloc[-2] and c.iloc[-1] > o.iloc[-2]):
                    detected = "harami_bearish"
            # Three bar
            if not detected and "morning_star" in patterns:
                if (c.iloc[-3] < o.iloc[-3] and
                        body_size.iloc[-2] < body_size.iloc[-3] * 0.3 and
                        c.iloc[-1] > o.iloc[-1] and
                        c.iloc[-1] > (o.iloc[-3] + c.iloc[-3]) / 2):
                    detected = "morning_star"
            if not detected and "evening_star" in patterns:
                if (c.iloc[-3] > o.iloc[-3] and
                        body_size.iloc[-2] < body_size.iloc[-3] * 0.3 and
                        c.iloc[-1] < o.iloc[-1] and
                        c.iloc[-1] < (o.iloc[-3] + c.iloc[-3]) / 2):
                    detected = "evening_star"
            if not detected and "three_white_soldiers" in patterns:
                if all(c.iloc[-i] > o.iloc[-i] and
                       c.iloc[-i] > c.iloc[-i-1] for i in range(1, 4)):
                    detected = "three_white_soldiers"
            if not detected and "three_black_crows" in patterns:
                if all(c.iloc[-i] < o.iloc[-i] and
                       c.iloc[-i] < c.iloc[-i-1] for i in range(1, 4)):
                    detected = "three_black_crows"

            if detected:
                matches.append(_result_row(instr, df, {"pattern": detected}))
                if len(matches) >= 200:
                    break
        except Exception:
            continue

    return {"count": len(matches), "matches": matches}


def _detect_vcp(
    df: pd.DataFrame,
    min_contractions: int = 2,
    max_contractions: int = 4,
    max_contraction_depth: float = 35.0,
    vdu_pct: float = 75.0,
    require_prior_uptrend: bool = True,
    near_pivot_pct: float = 5.0,
) -> bool:
    if len(df) < 100:
        return False
    close = df["close"]
    high = df["high"]
    low = df["low"]
    volume = df["volume"]

    # 1. Prior Uptrend Check
    if require_prior_uptrend:
        if len(df) < 200:
            return False
        sma150 = close.rolling(window=150).mean()
        sma200 = close.rolling(window=200).mean()
        if close.iloc[-1] < sma150.iloc[-1] or close.iloc[-1] < sma200.iloc[-1]:
            return False
        if len(sma200) >= 20 and sma200.iloc[-1] <= sma200.iloc[-20]:
            return False

    # 2. Local Peak and Trough Detection
    lookback_window = min(150, len(df))
    peaks = []
    troughs = []

    # Use a rolling window of 5 on each side
    for i in range(len(df) - lookback_window + 5, len(df) - 3):
        if high.iloc[i] == high.iloc[i-5:i+6].max():
            peaks.append((i, float(high.iloc[i])))
        if low.iloc[i] == low.iloc[i-5:i+6].min():
            troughs.append((i, float(low.iloc[i])))

    # 3. Alternate and Merge Swings
    swings = []
    for idx, val in peaks:
        swings.append(("PEAK", idx, val))
    for idx, val in troughs:
        swings.append(("TROUGH", idx, val))
    swings.sort(key=lambda x: x[1])

    if len(swings) < 4:
        return False

    cleaned_swings = []
    for s in swings:
        if not cleaned_swings:
            cleaned_swings.append(s)
            continue
        prev_type, prev_idx, prev_val = cleaned_swings[-1]
        curr_type, curr_idx, curr_val = s

        if prev_type == curr_type:
            if curr_type == "PEAK":
                if curr_val > prev_val:
                    cleaned_swings[-1] = s
            else:
                if curr_val < prev_val:
                    cleaned_swings[-1] = s
        else:
            cleaned_swings.append(s)

    contractions = []
    i = 0
    while i < len(cleaned_swings) - 1:
        if cleaned_swings[i][0] == "PEAK" and cleaned_swings[i+1][0] == "TROUGH":
            peak_val = cleaned_swings[i][2]
            trough_val = cleaned_swings[i+1][2]
            depth = (peak_val - trough_val) / peak_val * 100
            contractions.append({
                "peak_idx": cleaned_swings[i][1],
                "peak_val": peak_val,
                "trough_idx": cleaned_swings[i+1][1],
                "trough_val": trough_val,
                "depth": depth
            })
            i += 2
        else:
            i += 1

    if len(contractions) < min_contractions:
        return False

    contractions = contractions[-max_contractions:]

    # depths are contracting
    for k in range(1, len(contractions)):
        if contractions[k]["depth"] >= contractions[k-1]["depth"]:
            return False

    if contractions[0]["depth"] > max_contraction_depth:
        return False

    if contractions[-1]["depth"] > 8.0:
        return False

    # Pivot alignment
    peak_values = [c["peak_val"] for c in contractions]
    highest_peak = max(peak_values)
    lowest_peak = min(peak_values)

    if (highest_peak - lowest_peak) / lowest_peak * 100 > 10.0:
        return False

    pivot_level = highest_peak
    dist_to_pivot = (pivot_level - close.iloc[-1]) / pivot_level * 100
    if abs(dist_to_pivot) > near_pivot_pct:
        return False

    # Volume Dry-Up
    avg_vol_5 = volume.iloc[-5:].mean()
    avg_vol_50 = volume.iloc[-50:].mean()
    if avg_vol_50 > 0:
        vdu_ratio = (avg_vol_5 / avg_vol_50) * 100
        if vdu_ratio > vdu_pct:
            return False

    return True


# ── Other Scans ───────────────────────────────────────────────
@router.post("/other")
async def other_scanner(
    body: dict,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    scan_type = body.get("scan_type", "breakout")
    instruments = await _load_all_instruments(db)
    matches = []

    for instr in instruments:
        df = await _load_df(db, instr.id)
        if df is None:
            continue
        close = df["close"]
        h, l, v = df["high"], df["low"], df["volume"]
        try:
            matched = False

            if scan_type == "breakout":
                min_bars = body.get("min_bars", 10)
                max_bars = body.get("max_bars", 300)
                lookback = min(max_bars, len(df) - 1)
                swing_high = h.iloc[-lookback:-1].max()
                swing_low = l.iloc[-lookback:-1].min()
                if body.get("direction") == "down":
                    matched = close.iloc[-1] < swing_low
                else:
                    matched = close.iloc[-1] > swing_high

            elif scan_type == "vcp":
                min_c = int(body.get("min_contractions", 2))
                max_c = int(body.get("max_contractions", 4))
                max_depth = float(body.get("max_contraction_depth", 35.0))
                vdu_p = float(body.get("vdu_pct", 75.0))
                require_up = bool(body.get("require_prior_uptrend", True))
                near_p = float(body.get("near_pivot_pct", 5.0))
                matched = _detect_vcp(
                    df,
                    min_contractions=min_c,
                    max_contractions=max_c,
                    max_contraction_depth=max_depth,
                    vdu_pct=vdu_p,
                    require_prior_uptrend=require_up,
                    near_pivot_pct=near_p,
                )

            elif scan_type == "divergence":
                rsi = compute_rsi(close, body.get("rsi_period", 14))
                swing = body.get("min_swing", 10)
                ind = rsi if body.get("indicator") != "macd" else compute_macd(close)["macd"]
                if body.get("div_type") == "negative":
                    matched = close.iloc[-1] > close.iloc[-swing] and ind.iloc[-1] < ind.iloc[-swing]
                else:
                    matched = close.iloc[-1] < close.iloc[-swing] and ind.iloc[-1] > ind.iloc[-swing]

            elif scan_type == "week52":
                high_52 = h.rolling(252).max()
                low_52 = l.rolling(252).min()
                st = body.get("scan_type", "near_high")
                near_pct = body.get("near_pct", 5) / 100
                if st == "near_high":
                    matched = close.iloc[-1] >= high_52.iloc[-1] * (1 - near_pct)
                elif st == "near_low":
                    matched = close.iloc[-1] <= low_52.iloc[-1] * (1 + near_pct)
                elif st == "rebound_low":
                    mn, mx = body.get("rebound_min", 50) / 100, body.get("rebound_max", 60) / 100
                    rebound = (close.iloc[-1] - low_52.iloc[-1]) / low_52.iloc[-1]
                    matched = mn <= rebound <= mx
                elif st == "rebound_high":
                    mn, mx = body.get("rebound_min", 50) / 100, body.get("rebound_max", 60) / 100
                    rebound = (high_52.iloc[-1] - close.iloc[-1]) / high_52.iloc[-1]
                    matched = mn <= rebound <= mx

            elif scan_type == "volume":
                avg_period = body.get("avg_period", 20)
                vol_pct = body.get("vol_pct", 200) / 100
                avg_vol = v.rolling(avg_period).mean()
                vt = body.get("vol_type", "high_vol")
                rsi = compute_rsi(close, 14)
                rl = body.get("rsi_level", 50)
                if vt == "high_vol":
                    matched = v.iloc[-1] > avg_vol.iloc[-1] * vol_pct
                elif vt == "high_vol_rsi_below":
                    matched = v.iloc[-1] > avg_vol.iloc[-1] * vol_pct and rsi.iloc[-1] < rl
                elif vt == "high_vol_rsi_above":
                    matched = v.iloc[-1] > avg_vol.iloc[-1] * vol_pct and rsi.iloc[-1] > rl
                elif vt == "lifetime_high":
                    matched = v.iloc[-1] == v.max()

            elif scan_type == "hh_hl":
                sp = body.get("swing_period", 5)
                tt = body.get("trend_type", "hh_hl")
                loc_h = h.rolling(sp * 2 + 1, center=True).max()
                swings = h[h == loc_h]
                if tt == "hh_hl" and len(swings) >= 2:
                    matched = swings.iloc[-1] > swings.iloc[-2]
                elif tt == "ll_lh":
                    loc_l = l.rolling(sp * 2 + 1, center=True).min()
                    swings_l = l[l == loc_l]
                    matched = len(swings_l) >= 2 and swings_l.iloc[-1] < swings_l.iloc[-2]
                elif tt == "first_hh" and len(swings) >= 2:
                    matched = swings.iloc[-1] > swings.iloc[-2] and swings.iloc[-2] <= swings.iloc[-3] if len(swings) >= 3 else False
                elif tt == "first_ll":
                    loc_l = l.rolling(sp * 2 + 1, center=True).min()
                    swings_l = l[l == loc_l]
                    matched = len(swings_l) >= 3 and swings_l.iloc[-1] < swings_l.iloc[-2] and swings_l.iloc[-2] >= swings_l.iloc[-3]

            elif scan_type == "pivot":
                # Simplified weekly pivot calculation
                period = body.get("pivot_period", "W")
                n = 5 if period == "W" else 20
                ph = h.iloc[-n-1:-1].max()
                pl = l.iloc[-n-1:-1].min()
                pc = close.iloc[-n-1]
                pp = (ph + pl + pc) / 3
                r1 = 2 * pp - pl
                s1 = 2 * pp - ph
                action = body.get("pivot_action", "break_r1")
                if action == "break_r1":
                    matched = close.iloc[-1] > r1
                elif action == "break_s1":
                    matched = close.iloc[-1] < s1
                elif action == "support_pp":
                    matched = abs(close.iloc[-1] - pp) / pp < 0.005
                elif action == "resistance_pp":
                    matched = abs(h.iloc[-1] - pp) / pp < 0.005

            elif scan_type == "gaps":
                lookback = body.get("lookback", 5)
                min_gap = body.get("min_gap_pct", 1) / 100
                gt = body.get("gap_type", "gap_up")
                if gt == "gap_up":
                    for i in range(-lookback, 0):
                        gap = (l.iloc[i] - h.iloc[i - 1]) / h.iloc[i - 1]
                        if gap >= min_gap:
                            matched = True; break
                elif gt == "gap_down":
                    for i in range(-lookback, 0):
                        gap = (h.iloc[i - 1] - h.iloc[i]) / h.iloc[i - 1]
                        if gap >= min_gap:
                            matched = True; break
                elif gt == "gap_fill":
                    for i in range(-30, -lookback):
                        gap = (l.iloc[i] - h.iloc[i - 1]) / h.iloc[i - 1]
                        if abs(gap) >= min_gap:
                            gap_level = h.iloc[i - 1]
                            if min(l.iloc[-lookback:]) <= gap_level:
                                matched = True; break

            elif scan_type == "fibonacci":
                fib_pct = float(body.get("fib_level", 61.8)) / 100
                tol = body.get("tolerance", 2) / 100
                min_swing = body.get("min_swing_pct", 10) / 100
                direction = body.get("direction", "bullish")
                if direction == "bullish":
                    swing_high = h.rolling(50).max().iloc[-1]
                    swing_low = l.rolling(50).min().iloc[-1]
                    if (swing_high - swing_low) / swing_low >= min_swing:
                        retrace_level = swing_high - (swing_high - swing_low) * fib_pct
                        matched = abs(close.iloc[-1] - retrace_level) / retrace_level <= tol
                else:
                    swing_high = h.rolling(50).max().iloc[-1]
                    swing_low = l.rolling(50).min().iloc[-1]
                    if (swing_high - swing_low) / swing_low >= min_swing:
                        retrace_level = swing_low + (swing_high - swing_low) * fib_pct
                        matched = abs(close.iloc[-1] - retrace_level) / retrace_level <= tol

            elif scan_type == "range":
                rd = body.get("range_days", 20)
                max_rng = body.get("max_range_pct", 10) / 100
                period_h = h.iloc[-rd:-1].max()
                period_l = l.iloc[-rd:-1].min()
                range_pct = (period_h - period_l) / period_l
                in_range = range_pct <= max_rng
                rt = body.get("range_type", "breakout_up")
                if rt == "breakout_up":
                    matched = in_range and close.iloc[-1] > period_h
                elif rt == "breakout_down":
                    matched = in_range and close.iloc[-1] < period_l
                elif rt == "still_in_range":
                    matched = in_range and period_l <= close.iloc[-1] <= period_h

            elif scan_type == "elliott":
                lookback = int(body.get("lookback", 60))
                min_w3_pct = float(body.get("min_w3_pct", 10)) / 100
                max_w4_pct = float(body.get("max_w4_pct", 50)) / 100
                ew_dir = body.get("ew_dir", "bullish")
                if len(df) >= lookback:
                    sub_df = df.iloc[-lookback:]
                    h_sub, l_sub, c_sub = sub_df["high"], sub_df["low"], sub_df["close"]
                    if ew_dir == "bullish":
                        w3_peak_idx = h_sub.idxmax()
                        w3_peak_val = h_sub.loc[w3_peak_idx]
                        sub_before_peak = l_sub.loc[:w3_peak_idx]
                        if len(sub_before_peak) >= 5:
                            w2_bottom_val = sub_before_peak.min()
                            w3_rally_pct = (w3_peak_val - w2_bottom_val) / w2_bottom_val if w2_bottom_val > 0 else 0
                            curr_close = c_sub.iloc[-1]
                            curr_retrace = (w3_peak_val - curr_close) / (w3_peak_val - w2_bottom_val) if (w3_peak_val - w2_bottom_val) > 0 else 0
                            is_w3_peak_past = (w3_peak_idx < sub_df.index[-2])
                            matched = (
                                w3_rally_pct >= min_w3_pct and
                                is_w3_peak_past and
                                0.15 <= curr_retrace <= max_w4_pct and
                                curr_close > w2_bottom_val
                            )
                    else:
                        w3_bot_idx = l_sub.idxmin()
                        w3_bot_val = l_sub.loc[w3_bot_idx]
                        sub_before_bot = h_sub.loc[:w3_bot_idx]
                        if len(sub_before_bot) >= 5:
                            w2_peak_val = sub_before_bot.max()
                            w3_decline_pct = (w2_peak_val - w3_bot_val) / w2_peak_val if w2_peak_val > 0 else 0
                            curr_close = c_sub.iloc[-1]
                            curr_retrace = (curr_close - w3_bot_val) / (w2_peak_val - w3_bot_val) if (w2_peak_val - w3_bot_val) > 0 else 0
                            is_w3_bot_past = (w3_bot_idx < sub_df.index[-2])
                            matched = (
                                w3_decline_pct >= min_w3_pct and
                                is_w3_bot_past and
                                0.15 <= curr_retrace <= max_w4_pct and
                                curr_close < w2_peak_val
                            )

            elif scan_type == "gann_swing":
                sb_val = int(body.get("swing_bars", 5))
                confirm_swings = int(body.get("confirm_swings", 2))
                gann_trend = body.get("gann_trend", "uptrend")
                if len(df) >= sb_val * confirm_swings * 2:
                    loc_h = h.rolling(sb_val * 2 + 1, center=True).max()
                    loc_l = l.rolling(sb_val * 2 + 1, center=True).min()
                    swings_h = h[h == loc_h].dropna()
                    swings_l = l[l == loc_l].dropna()
                    if len(swings_h) >= confirm_swings + 1 and len(swings_l) >= confirm_swings + 1:
                        last_highs = swings_h.iloc[-(confirm_swings + 1):]
                        last_lows = swings_l.iloc[-(confirm_swings + 1):]
                        hh = all(last_highs.iloc[i] > last_highs.iloc[i-1] for i in range(1, len(last_highs)))
                        hl = all(last_lows.iloc[i] > last_lows.iloc[i-1] for i in range(1, len(last_lows)))
                        lh = all(last_highs.iloc[i] < last_highs.iloc[i-1] for i in range(1, len(last_highs)))
                        ll = all(last_lows.iloc[i] < last_lows.iloc[i-1] for i in range(1, len(last_lows)))
                        if gann_trend == "uptrend":
                            matched = hh and hl
                        elif gann_trend == "downtrend":
                            matched = lh and ll
                        elif gann_trend == "reversal":
                            recent_h = swings_h.iloc[-1]
                            recent_l = swings_l.iloc[-1]
                            prev_close = close.iloc[-2]
                            curr_close = close.iloc[-1]
                            matched = (prev_close <= recent_h < curr_close) or (prev_close >= recent_l > curr_close)

            if matched:
                matches.append(_result_row(instr, df))
                if len(matches) >= 200:
                    break
        except Exception:
            continue

    return {"count": len(matches), "matches": matches}
