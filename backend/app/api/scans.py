"""PEESTOCK — Dedicated Scan Endpoints (MA, Indicators, Candlesticks, Other)."""
from __future__ import annotations
from typing import Optional
import numpy as np
import pandas as pd
from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from app.database import get_db
from app.models import Instrument, OhlcvEod, IndexConstituent
from app.auth import get_current_user
from app.models import User
from app.services.scanner_engine import (
    compute_sma, compute_ema, compute_rsi, compute_macd,
    compute_supertrend, compute_ichimoku, compute_bbands,
    compute_atr, compute_slope, compute_engulfing,
    compute_hammer, compute_doji,
    compute_psar, compute_hl_sar, compute_ma_oscillator,
    compute_ma_band, compute_heikin_ashi,
)

router = APIRouter(prefix="/api/scans", tags=["scans"])

LOOKBACK = 300  # bars to fetch per instrument
MAX_INSTRUMENTS = 5000
MATCH_CAP = 200  # max matches returned per scan (results are truncated beyond this)

# Valid inputs per scan — used to give callers a clear error instead of a silent
# empty result when a parameter is misspelled or unsupported.
VALID_INDICATORS = {
    "supertrend", "sar", "ma_oscillator", "ma_band", "bbands", "ichimoku",
    "trend_candle", "rsi", "macd", "rsi_macd", "zigzag", "fibonacci",
}
VALID_CANDLE_PATTERNS = {
    "doji", "hammer", "shooting_star", "marubozu_bullish", "marubozu_bearish",
    "engulfing_bullish", "engulfing_bearish", "harami_bullish", "harami_bearish",
    "morning_star", "evening_star", "piercing_line", "dark_cloud_cover",
    "three_white_soldiers", "three_black_crows",
}
VALID_OTHER_SCAN_TYPES = {
    "breakout", "mtf_bullish", "vcp", "divergence", "volume", "gainers_losers",
    "hh_hl", "pivot", "gaps", "fibonacci", "range", "elliott", "gann_swing",
    # 52-week high/low family — handled in other_scanner but was missing from
    # this allowlist, so the whole 52-Week H/L tab got "Unknown scan_type".
    "week52", "near_high", "near_low", "rebound_high", "rebound_low",
}

_TF_WORD = {"D": "daily", "W": "weekly", "M": "monthly"}


def _scan_result(matches: list, subject: str, timeframe: str = "D", index: str = None) -> dict:
    """Build a scan response with a human-readable `message` so an empty result is
    never ambiguous. Also flags when the match cap truncated the list.

    Matches arrive in arbitrary instrument order; rank the strongest movers first
    so the top of every scan is the most actionable, not the alphabetically lucky."""
    try:
        matches = sorted(matches, key=lambda m: abs(m.get("change_pct") or 0), reverse=True)
    except Exception:
        pass
    n = len(matches)
    tf = _TF_WORD.get(timeframe, timeframe)
    scope = f" in {index.replace('_', ' ')}" if index else ""
    truncated = n >= MATCH_CAP
    if n == 0:
        msg = f"No instruments currently match {subject}{scope} on the {tf} timeframe."
    elif truncated:
        msg = (f"Showing the first {n} instruments matching {subject}{scope} ({tf}); "
               f"more may exist — narrow by index or sector to refine.")
    else:
        msg = (f"Found {n} instrument{'s' if n != 1 else ''} matching {subject}{scope} "
               f"on the {tf} timeframe.")
    return {"count": n, "matches": matches, "message": msg, "truncated": truncated}


def _invalid_scan(message: str) -> dict:
    """200-status response signalling the request parameters were unusable."""
    return {"count": 0, "matches": [], "message": message, "error": "invalid_input"}


async def _load_all_instruments(db: AsyncSession, sector: str = None, index: str = None):
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
    rows = (await db.execute(stmt.limit(MAX_INSTRUMENTS))).scalars().all()
    return rows


def _fetch_limit_for(timeframe: str, limit: int) -> int:
    """Daily bars to pull. W/M need a deeper daily window to resample from."""
    return max(limit * 7, 1500) if timeframe in ("W", "M") else limit


def _finalize_df(rows_asc, timeframe: str) -> pd.DataFrame | None:
    """Build the analysis frame from chronological (oldest→newest) OHLCV rows.

    Kept separate from `_load_df` so the row→frame transform (type casts + W/M
    resampling) lives in one place.
    """
    if len(rows_asc) < 15:
        return None

    df = pd.DataFrame(list(rows_asc), columns=["time", "open", "high", "low", "close", "volume"])
    df["time"] = df["time"].apply(lambda t: t.isoformat() if hasattr(t, "isoformat") else str(t))
    for col in ("open", "high", "low", "close"):
        df[col] = df[col].astype(float)
    df["volume"] = df["volume"].fillna(0).astype("int64")

    if timeframe == "W" and not df.empty:
        df["time"] = pd.to_datetime(df["time"])
        df = df.set_index("time")
        try:
            df = df.resample("W-FRI").agg({
                "open": "first", "high": "max", "low": "min", "close": "last", "volume": "sum"
            }).dropna()
        except Exception:
            df = df.resample("W").agg({
                "open": "first", "high": "max", "low": "min", "close": "last", "volume": "sum"
            }).dropna()
        df = df.reset_index()
        df["time"] = df["time"].dt.strftime("%Y-%m-%d")
    elif timeframe == "M" and not df.empty:
        df["time"] = pd.to_datetime(df["time"])
        df = df.set_index("time")
        try:
            df = df.resample("ME").agg({
                "open": "first", "high": "max", "low": "min", "close": "last", "volume": "sum"
            }).dropna()
        except Exception:
            df = df.resample("M").agg({
                "open": "first", "high": "max", "low": "min", "close": "last", "volume": "sum"
            }).dropna()
        df = df.reset_index()
        df["time"] = df["time"].dt.strftime("%Y-%m-%d")

    return df


async def _load_df(db: AsyncSession, instr_id, timeframe: str = "D", limit: int = LOOKBACK) -> pd.DataFrame | None:
    # Raw column fetch riding the (instrument_id, time DESC) index. Returns the
    # latest `fetch_limit` bars (newest-first), reversed to chronological order.
    from sqlalchemy import text as _text
    fetch_limit = _fetch_limit_for(timeframe, limit)
    rows = (await db.execute(
        _text(
            "SELECT time, open, high, low, close, volume FROM ohlcv_eod "
            "WHERE instrument_id = :iid AND open IS NOT NULL AND high IS NOT NULL "
            "AND low IS NOT NULL AND close IS NOT NULL "
            "ORDER BY time DESC LIMIT :lim"
        ),
        {"iid": instr_id, "lim": fetch_limit},
    )).all()
    return _finalize_df(rows[::-1], timeframe)


def _scan_quality_ok(instr, df: pd.DataFrame, liquid_only: bool = True) -> bool:
    """Shared quality gate for every scanner: drop stale and illiquid instruments.

    - Freshness: last bar within ~7 calendar days (dead/suspended listings match
      scans forever on their frozen final bars otherwise).
    - Liquidity: 20-bar avg turnover ≥ ₹1 crore for stocks & commodities. Indices
      and forex are exempt (no meaningful volume data).
    """
    try:
        from datetime import datetime, timedelta
        last_t = str(df["time"].iloc[-1])[:10]
        if datetime.strptime(last_t, "%Y-%m-%d") < datetime.now() - timedelta(days=7):
            return False
    except Exception:
        pass
    if liquid_only and getattr(instr, "segment", "EQ") in ("EQ", "COMM"):
        tail = df.tail(20)
        turnover = float((tail["close"] * tail["volume"]).mean())
        if turnover < 1e7:
            return False
    return True


def _result_row(instr, df: pd.DataFrame, extra: dict = None):
    last = df.iloc[-1]
    prev = df.iloc[-2] if len(df) > 1 else last
    chg = ((last["close"] - prev["close"]) / prev["close"] * 100) if prev["close"] else 0
    row = {
        "symbol": instr.symbol, "name": instr.name,
        "sector": instr.sector or "—",
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
    pct_threshold: float = Query(3.0),
    pullback_tolerance: float = Query(1.5),
    pullback_trend_bars: int = Query(10),
    sector: Optional[str] = Query(None),
    index: Optional[str] = Query(None),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    from app.services.subscription_validator import validate_timeframe_access
    await validate_timeframe_access(user, timeframe, db)

    from app.services import scan_cache, scan_history
    _params = {"scan_type": scan_type, "ma_type": ma_type, "period1": period1,
               "period2": period2, "period3": period3, "direction": direction,
               "timeframe": timeframe, "rsi_filter": rsi_filter, "sector": sector, "index": index}
    _ck = scan_cache.make_key("scans_ma", [scan_type, ma_type, period1, period2, period3,
                              direction, timeframe, rsi_filter, pct_threshold,
                              pullback_tolerance, pullback_trend_bars, sector, index])
    _cached = scan_cache.get(_ck)
    if _cached is not None:
        return _cached

    instruments = await _load_all_instruments(db, sector, index)
    liquid_only = bool(body.get("liquid_only", True)) if isinstance(locals().get("body"), dict) else True
    matches = []

    def get_ma(close: pd.Series, period: int) -> pd.Series:
        if ma_type.upper() == "SMA":
            return compute_sma(close, period)
        elif ma_type.upper() == "WMA":
            w = np.arange(1, period + 1)
            w_sum = w.sum()
            vals = close.values
            if len(vals) < period:
                return pd.Series(index=close.index, dtype=float)
            conv = np.convolve(vals, w[::-1] / w_sum, mode="valid")
            pad = np.full(period - 1, np.nan)
            return pd.Series(np.concatenate([pad, conv]), index=close.index)
        return compute_ema(close, period)

    for instr in instruments:
        df = await _load_df(db, instr.id, timeframe)
        if df is None:
            continue
        if not _scan_quality_ok(instr, df, liquid_only):
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

            elif scan_type == "price_ma_pct":
                diff_pct = (close.iloc[-1] - ma1.iloc[-1]) / ma1.iloc[-1] * 100
                if direction == "bullish":
                    matched = diff_pct >= pct_threshold
                else:
                    matched = diff_pct <= -pct_threshold

            elif scan_type == "pullback":
                # Price was clearly on one side of the MA for the prior N bars (a trend),
                # and has now pulled back to within `pullback_tolerance`% of the MA line.
                n = pullback_trend_bars
                if len(df) > n + 1:
                    dist_pct = abs(close.iloc[-1] - ma1.iloc[-1]) / ma1.iloc[-1] * 100
                    near_ma = dist_pct <= pullback_tolerance
                    if direction == "bullish":
                        was_trending = (close.iloc[-n - 1:-1] > ma1.iloc[-n - 1:-1]).all()
                        matched = was_trending and near_ma and close.iloc[-1] >= ma1.iloc[-1] * (1 - pullback_tolerance / 100)
                    else:
                        was_trending = (close.iloc[-n - 1:-1] < ma1.iloc[-n - 1:-1]).all()
                        matched = was_trending and near_ma and close.iloc[-1] <= ma1.iloc[-1] * (1 + pullback_tolerance / 100)

            if not matched:
                continue

            extra = {}
            if scan_type == "price_ma_pct":
                extra["ma_diff_pct"] = round(float((close.iloc[-1] - ma1.iloc[-1]) / ma1.iloc[-1] * 100), 2)

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

            matches.append(_result_row(instr, df, extra))
            if len(matches) >= 200:
                break
        except Exception:
            continue

    _res = _scan_result(matches, f"{ma_type} {scan_type.replace('_', ' ')} ({direction})", timeframe, index)
    scan_cache.set(_ck, _res)
    await scan_history.record(user.id, "ma", _params, _res["matches"])
    return _res


# ── Indicator Scanner ─────────────────────────────────────────
@router.post("/indicators")
async def indicator_scanner(
    body: dict,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    timeframe = body.get("timeframe", "D")
    from app.services.subscription_validator import validate_timeframe_access
    await validate_timeframe_access(user, timeframe, db)
    
    indicator = body.get("indicator", "supertrend")
    signal = body.get("signal", "buy")
    if indicator not in VALID_INDICATORS:
        return _invalid_scan(
            f"Unknown indicator '{indicator}'. Supported indicators: "
            f"{', '.join(sorted(VALID_INDICATORS))}."
        )
    sector = body.get("sector")
    index = body.get("index")

    from app.services import scan_cache, scan_history
    _ck = scan_cache.make_key("scans_indicator", body)
    _cached = scan_cache.get(_ck)
    if _cached is not None:
        return _cached

    instruments = await _load_all_instruments(db, sector, index)
    liquid_only = bool(body.get("liquid_only", True)) if isinstance(locals().get("body"), dict) else True
    matches = []

    for instr in instruments:
        df = await _load_df(db, instr.id, timeframe)
        if df is None:
            continue
        if not _scan_quality_ok(instr, df, liquid_only):
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

            elif indicator in ("rsi", "macd", "rsi_macd"):
                check_rsi = (indicator in ("rsi", "rsi_macd"))
                check_macd = (indicator in ("macd", "rsi_macd"))
                
                rsi_matched = True
                if check_rsi:
                    rsi_period = body.get("rsi_period", 14)
                    rsi_level = body.get("rsi_level", 50)
                    rsi_sig = body.get("rsi_signal", body.get("signal", "above_level"))
                    
                    if rsi_sig == "oversold":
                        rsi_sig = "below_level"
                        rsi_level = 30.0
                    elif rsi_sig == "overbought":
                        rsi_sig = "above_level"
                        rsi_level = 70.0
                    
                    rsi = compute_rsi(close, rsi_period)
                    
                    if rsi_sig == "above_level":
                        rsi_matched = rsi.iloc[-1] > rsi_level
                    elif rsi_sig == "below_level":
                        rsi_matched = rsi.iloc[-1] < rsi_level
                        sig_dir = "bearish"
                    elif rsi_sig == "divergence_pos":
                        price_lower = close.iloc[-1] < close.iloc[-10]
                        rsi_higher = rsi.iloc[-1] > rsi.iloc[-10]
                        rsi_matched = price_lower and rsi_higher
                    elif rsi_sig == "divergence_neg":
                        rsi_matched = close.iloc[-1] > close.iloc[-10] and rsi.iloc[-1] < rsi.iloc[-10]
                        sig_dir = "bearish"
                    elif rsi_sig == "breakout":
                        rsi_matched = rsi.iloc[-1] == rsi.iloc[-20:].max()
                    elif rsi_sig == "range":
                        rsi_min = float(body.get("rsi_min", 30.0))
                        rsi_max = float(body.get("rsi_max", 70.0))
                        rsi_matched = rsi_min <= rsi.iloc[-1] <= rsi_max
                        sig_dir = "bullish" if rsi.iloc[-1] < 50 else "bearish"
                        
                macd_matched = True
                if check_macd:
                    macd_fast = int(body.get("macd_fast", 12))
                    macd_slow = int(body.get("macd_slow", 26))
                    macd_signal = int(body.get("macd_signal", 9))
                    macd_sig_type = body.get("macd_signal_type", body.get("signal", "bullish_cross"))
                    
                    macd_data = compute_macd(close, fast=macd_fast, slow=macd_slow, signal=macd_signal)
                    macd_line = macd_data["macd"]
                    signal_line = macd_data["signal"]
                    hist = macd_data["histogram"]
                    
                    if macd_sig_type in ("bullish_cross", "bullish_crossover"):
                        macd_matched = macd_line.iloc[-2] <= signal_line.iloc[-2] and macd_line.iloc[-1] > signal_line.iloc[-1]
                    elif macd_sig_type in ("bearish_cross", "bearish_crossover"):
                        macd_matched = macd_line.iloc[-2] >= signal_line.iloc[-2] and macd_line.iloc[-1] < signal_line.iloc[-1]
                        sig_dir = "bearish"
                    elif macd_sig_type == "histogram_pos":
                        macd_matched = hist.iloc[-1] > 0
                    elif macd_sig_type == "divergence":
                        price_lower = close.iloc[-1] < close.iloc[-10]
                        macd_higher = macd_line.iloc[-1] > macd_line.iloc[-10]
                        macd_matched = price_lower and macd_higher
                        
                matched = rsi_matched and macd_matched

            elif indicator == "sar":
                sar_type = body.get("sar_type", "parabolic")
                if sar_type == "hl_sar":
                    trend = compute_hl_sar(df, period=body.get("period", 21))["trend"]
                elif sar_type in ("ats", "sar_special"):
                    # ATS/SAR and SAR Special are proprietary KeyStocks formulas with no
                    # public spec; approximate with Supertrend rather than guess the math.
                    trend = compute_supertrend(df, period=10, multiplier=3.0)["trend"]
                else:
                    trend = compute_psar(df, step=body.get("step", 0.02), max_step=body.get("max_step", 0.2))["trend"]
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

            elif indicator == "ma_oscillator":
                osc = compute_ma_oscillator(
                    close, fast=body.get("fast", 10), slow=body.get("slow", 20),
                    ma_type=body.get("ma_type", "EMA"),
                )
                if signal == "above_zero":
                    matched = osc.iloc[-1] > 0
                elif signal == "below_zero":
                    matched = osc.iloc[-1] < 0; sig_dir = "bearish"
                elif signal == "cross_above_zero":
                    matched = osc.iloc[-2] <= 0 and osc.iloc[-1] > 0
                elif signal == "cross_below_zero":
                    matched = osc.iloc[-2] >= 0 and osc.iloc[-1] < 0; sig_dir = "bearish"

            elif indicator == "ma_band":
                band = compute_ma_band(
                    close, period=body.get("period", 20),
                    band_pct=body.get("band_pct", 2.5), ma_type=body.get("ma_type", "SMA"),
                )
                if signal == "breakout_up":
                    matched = close.iloc[-1] > band["upper"].iloc[-1]
                elif signal == "breakout_down":
                    matched = close.iloc[-1] < band["lower"].iloc[-1]; sig_dir = "bearish"
                elif signal == "inside_band":
                    matched = band["lower"].iloc[-1] <= close.iloc[-1] <= band["upper"].iloc[-1]
                elif signal == "touch_upper":
                    matched = abs(close.iloc[-1] - band["upper"].iloc[-1]) / close.iloc[-1] < 0.01
                elif signal == "touch_lower":
                    matched = abs(close.iloc[-1] - band["lower"].iloc[-1]) / close.iloc[-1] < 0.01; sig_dir = "bearish"

            elif indicator == "trend_candle":
                ha = compute_heikin_ashi(df)
                trend = ha["trend"]
                if signal == "bullish":
                    matched = trend.iloc[-1] > 0
                elif signal == "bearish":
                    matched = trend.iloc[-1] < 0; sig_dir = "bearish"
                elif signal == "flip_bullish":
                    matched = trend.iloc[-2] < 0 and trend.iloc[-1] > 0
                elif signal == "flip_bearish":
                    matched = trend.iloc[-2] > 0 and trend.iloc[-1] < 0; sig_dir = "bearish"

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

    _res = _scan_result(matches, f"{indicator.upper()} {signal.replace('_', ' ')}", timeframe, index)
    scan_cache.set(_ck, _res)
    await scan_history.record(user.id, "indicator", body, _res["matches"])
    return _res


def _bar_field(df: pd.DataFrame, field: str, bar_offset: int = 0) -> float:
    """Read a single OHLCV-derived value `bar_offset` bars back from the latest bar."""
    idx = -1 - bar_offset
    o, h, l, c = df["open"].iloc[idx], df["high"].iloc[idx], df["low"].iloc[idx], df["close"].iloc[idx]
    if field == "body_size":
        return abs(c - o)
    if field == "range":
        return h - l
    if field == "upper_shadow":
        return h - max(o, c)
    if field == "lower_shadow":
        return min(o, c) - l
    return {"open": o, "high": h, "low": l, "close": c, "volume": df["volume"].iloc[idx]}[field]


def _eval_custom_rule(df: pd.DataFrame, rule: dict) -> bool:
    a = _bar_field(df, rule.get("field", "close"), rule.get("bar", 0))
    if "compare_field" in rule:
        b = _bar_field(df, rule["compare_field"], rule.get("compare_bar", rule.get("bar", 0)))
    elif "value_mult" in rule:
        ref = _bar_field(df, rule.get("value_field", "range"), rule.get("value_bar", rule.get("bar", 0)))
        b = ref * rule["value_mult"]
    else:
        b = rule.get("value", 0)

    op = rule.get("op", "gt")
    if op in ("gt", "above"):
        return a > b
    elif op in ("lt", "below"):
        return a < b
    elif op == "gte":
        return a >= b
    elif op == "lte":
        return a <= b
    elif op == "eq":
        return abs(a - b) < 1e-6
    return False


def _eval_custom_pattern(df: pd.DataFrame, rules: list, logic: str = "AND") -> bool:
    """Evaluate a user-built candlestick pattern: a list of raw OHLC comparison
    rules (e.g. {"field": "close", "op": "gt", "compare_field": "open"}) ANDed/ORed together."""
    if len(df) < 5 or not rules:
        return False
    try:
        results = [_eval_custom_rule(df, r) for r in rules]
    except (KeyError, IndexError, ZeroDivisionError):
        return False
    return all(results) if logic != "OR" else any(results)


# ── Candlestick Scanner ───────────────────────────────────────
@router.post("/candlesticks")
async def candlestick_scanner(
    body: dict,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    timeframe = body.get("timeframe", "D")
    from app.services.subscription_validator import validate_timeframe_access
    await validate_timeframe_access(user, timeframe, db)
    
    patterns = set(body.get("patterns", []))
    custom_patterns = body.get("custom_patterns", [])
    if not patterns and not custom_patterns:
        return _invalid_scan(
            "No candlestick pattern specified. Pass a 'patterns' list, e.g. "
            '{"patterns": ["hammer", "doji"]}. Supported: '
            f"{', '.join(sorted(VALID_CANDLE_PATTERNS))}."
        )
    unknown = patterns - VALID_CANDLE_PATTERNS
    if unknown and not custom_patterns:
        return _invalid_scan(
            f"Unknown candlestick pattern(s): {', '.join(sorted(unknown))}. Supported: "
            f"{', '.join(sorted(VALID_CANDLE_PATTERNS))}."
        )

    sector = body.get("sector")
    index = body.get("index")

    from app.services import scan_cache, scan_history
    _ck = scan_cache.make_key("scans_candles", body)
    _cached = scan_cache.get(_ck)
    if _cached is not None:
        return _cached

    instruments = await _load_all_instruments(db, sector, index)
    liquid_only = bool(body.get("liquid_only", True)) if isinstance(locals().get("body"), dict) else True
    matches = []

    for instr in instruments:
        df = await _load_df(db, instr.id, timeframe, limit=50)
        if df is None:
            continue
        if not _scan_quality_ok(instr, df, liquid_only):
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

            # User-defined candlestick patterns built from raw OHLC comparisons.
            if not detected and custom_patterns:
                for cp in custom_patterns:
                    if _eval_custom_pattern(df, cp.get("rules", []), cp.get("logic", "AND")):
                        detected = cp.get("name", "custom")
                        break

            if detected:
                matches.append(_result_row(instr, df, {"pattern": detected}))
                if len(matches) >= 200:
                    break
        except Exception:
            continue

    subject = ", ".join(sorted(p.replace("_", " ") for p in patterns)) or "custom pattern"
    _res = _scan_result(matches, f"{subject} candlestick(s)", timeframe, index)
    scan_cache.set(_ck, _res)
    await scan_history.record(user.id, "candlestick", body, _res["matches"])
    return _res


def _detect_vcp(
    df: pd.DataFrame,
    min_contractions: int = 2,
    max_contractions: int = 4,
    max_contraction_depth: float = 35.0,
    vdu_pct: float = 100.0,
    require_prior_uptrend: bool = True,
    near_pivot_pct: float = 8.0,
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

    # depths are generally contracting (allow 20% tolerance for intermediate swings)
    for k in range(1, len(contractions)):
        if contractions[k]["depth"] > contractions[k-1]["depth"] * 1.2:
            return False

    if contractions[0]["depth"] > max_contraction_depth:
        return False

    if contractions[-1]["depth"] > 12.0:
        return False

    # Overall it must be a contraction from start to finish
    if contractions[-1]["depth"] >= contractions[0]["depth"]:
        return False

    # Pivot alignment
    peak_values = [c["peak_val"] for c in contractions]
    highest_peak = max(peak_values)
    lowest_peak = min(peak_values)

    if (highest_peak - lowest_peak) / lowest_peak * 100 > 15.0:
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
    if scan_type not in VALID_OTHER_SCAN_TYPES:
        return _invalid_scan(
            f"Unknown scan_type '{scan_type}'. Supported scan types: "
            f"{', '.join(sorted(VALID_OTHER_SCAN_TYPES))}."
        )
    from app.services.subscription_validator import validate_timeframe_access
    if scan_type == "mtf_bullish":
        # Multi-timeframe scan requires both W and M timeframes (EOD Pro or higher)
        await validate_timeframe_access(user, "W", db)
        await validate_timeframe_access(user, "M", db)
    else:
        timeframe = body.get("timeframe", "D")
        await validate_timeframe_access(user, timeframe, db)
        
    sector = body.get("sector")
    index = body.get("index")

    from app.services import scan_cache, scan_history
    _ck = scan_cache.make_key("scans_other", body)
    _cached = scan_cache.get(_ck)
    if _cached is not None:
        return _cached

    instruments = await _load_all_instruments(db, sector, index)
    liquid_only = bool(body.get("liquid_only", True)) if isinstance(locals().get("body"), dict) else True
    matches = []

    for instr in instruments:
        if scan_type == "mtf_bullish":
            df = await _load_df(db, instr.id, "D")
        else:
            df = await _load_df(db, instr.id, timeframe)
        if df is None:
            continue
        if not _scan_quality_ok(instr, df, liquid_only):
            continue
        close = df["close"]
        h, l, v = df["high"], df["low"], df["volume"]
        try:
            matched = False
            extra = {}

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

            elif scan_type == "mtf_bullish":
                # Multi-Timeframe Candle Alignment: Daily, Weekly, and Monthly charts.
                # Parameters: candle_type (bullish, bearish, doji, hammer, shooting_star, marubozu_bullish, marubozu_bearish)
                candle_type = body.get("candle_type", "bullish")
                
                if len(df) >= 40:
                    df_res = df.copy()
                    df_res["time"] = pd.to_datetime(df_res["time"])
                    df_res = df_res.set_index("time")
                    
                    # 1. Daily Candle
                    d_candle = df_res.iloc[-1]
                    d_open = float(d_candle["open"])
                    d_high = float(d_candle["high"])
                    d_low = float(d_candle["low"])
                    d_close = float(d_candle["close"])
                    
                    # Helper to check candle type
                    def check_candle(o, h, l, c, c_type):
                        body_size = abs(c - o)
                        rng = h - l
                        if rng <= 0:
                            return False
                        if c_type == "bullish":
                            return c > o
                        elif c_type == "bearish":
                            return c < o
                        elif c_type == "doji":
                            return body_size <= rng * 0.1
                        elif c_type == "hammer":
                            ls = min(o, c) - l
                            us = h - max(o, c)
                            return ls > 2 * body_size and us < 0.1 * rng
                        elif c_type == "shooting_star":
                            us = h - max(o, c)
                            ls = min(o, c) - l
                            return us > 2 * body_size and ls < 0.1 * rng
                        elif c_type == "marubozu_bullish":
                            return c > o and body_size > rng * 0.9
                        elif c_type == "marubozu_bearish":
                            return c < o and body_size > rng * 0.9
                        return False
                        
                    if check_candle(d_open, d_high, d_low, d_close, candle_type):
                        # 2. Weekly Candle (Resample Daily EOD to Weekly)
                        try:
                            df_w = df_res.resample("W-FRI").agg({
                                "open": "first", "high": "max", "low": "min", "close": "last", "volume": "sum"
                            }).dropna()
                        except Exception:
                            df_w = df_res.resample("W").agg({
                                "open": "first", "high": "max", "low": "min", "close": "last", "volume": "sum"
                            }).dropna()
                            
                        if not df_w.empty:
                            w_candle = df_w.iloc[-1]
                            w_open = float(w_candle["open"])
                            w_high = float(w_candle["high"])
                            w_low = float(w_candle["low"])
                            w_close = float(w_candle["close"])
                            
                            if check_candle(w_open, w_high, w_low, w_close, candle_type):
                                # 3. Monthly Candle (Resample Daily EOD to Monthly)
                                try:
                                    df_m = df_res.resample("ME").agg({
                                        "open": "first", "high": "max", "low": "min", "close": "last", "volume": "sum"
                                    }).dropna()
                                except Exception:
                                    df_m = df_res.resample("M").agg({
                                        "open": "first", "high": "max", "low": "min", "close": "last", "volume": "sum"
                                    }).dropna()
                                    
                                if not df_m.empty:
                                    m_candle = df_m.iloc[-1]
                                    m_open = float(m_candle["open"])
                                    m_high = float(m_candle["high"])
                                    m_low = float(m_candle["low"])
                                    m_close = float(m_candle["close"])
                                    
                                    if check_candle(m_open, m_high, m_low, m_close, candle_type):
                                        matched = True
                                        extra = {
                                            "d_gain": round((d_close - d_open) / d_open * 100, 2) if d_open else 0,
                                            "w_gain": round((w_close - w_open) / w_open * 100, 2) if w_open else 0,
                                            "m_gain": round((m_close - m_open) / m_open * 100, 2) if m_open else 0,
                                        }

            elif scan_type == "vcp":
                min_c = int(body.get("min_contractions", 2))
                max_c = int(body.get("max_contractions", 4))
                max_depth = float(body.get("max_contraction_depth", 35.0))
                vdu_p = float(body.get("vdu_pct", 100.0))
                require_up = bool(body.get("require_prior_uptrend", True))
                near_p = float(body.get("near_pivot_pct", 8.0))
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

            elif scan_type in ("week52", "near_high", "near_low", "rebound_low", "rebound_high"):
                high_52 = h.rolling(252).max()
                low_52 = l.rolling(252).min()
                st = scan_type if scan_type != "week52" else body.get("scan_type", "near_high")
                if st not in ("near_high", "near_low", "rebound_low", "rebound_high"):
                    st = "near_high"
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

            elif scan_type == "gainers_losers":
                # Combined price-move + volume-surge scan: a price gainer/loser
                # is only interesting if it's also trading on above-average volume.
                price_chg = (close.iloc[-1] - close.iloc[-2]) / close.iloc[-2] * 100
                min_price_chg = body.get("min_price_chg_pct", 3.0)
                avg_period = body.get("avg_period", 20)
                avg_vol = v.rolling(avg_period).mean()
                vol_mult = body.get("vol_mult", 1.5)
                vol_surge = avg_vol.iloc[-1] > 0 and v.iloc[-1] >= avg_vol.iloc[-1] * vol_mult
                direction_pl = body.get("direction", "gainers")
                if direction_pl == "gainers":
                    matched = price_chg >= min_price_chg and vol_surge
                else:
                    matched = price_chg <= -min_price_chg and vol_surge

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
                matches.append(_result_row(instr, df, extra))
                if len(matches) >= 200:
                    break
        except Exception:
            continue

    if scan_type == "mtf_bullish":
        candle_type = body.get("candle_type", "bullish")
        is_bearish_scan = candle_type in ("bearish", "marubozu_bearish")
        matches = sorted(matches, key=lambda x: x.get("m_gain", 0), reverse=not is_bearish_scan)

    result_tf = "D" if scan_type == "mtf_bullish" else body.get("timeframe", "D")
    _res = _scan_result(matches, scan_type.replace("_", " "), result_tf, body.get("index"))
    scan_cache.set(_ck, _res)
    await scan_history.record(user.id, "other", body, _res["matches"])
    return _res


@router.get("/intraday-desk")
async def get_intraday_desk(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    from sqlalchemy import text
    import numpy as np

    # Find latest EOD date
    res = await db.execute(text("SELECT MAX(time) FROM ohlcv_eod;"))
    latest_date = res.scalar()
    if not latest_date:
        return {"error": "No data in database"}

    # Find previous EOD date
    res = await db.execute(text("SELECT MAX(time) FROM ohlcv_eod WHERE time < :latest_date;"), {"latest_date": latest_date})
    prev_date = res.scalar()
    if not prev_date:
        prev_date = latest_date

    # Load EQ instruments
    res = await db.execute(text("SELECT id, symbol, name, sector FROM instruments WHERE segment = 'EQ' AND is_active = 1;"))
    eq_rows = res.fetchall()
    eq_instruments = {row[0]: {"symbol": row[1], "name": row[2], "sector": row[3] or "Other"} for row in eq_rows}

    # Load EOD data for latest_date
    res = await db.execute(text("SELECT instrument_id, open, high, low, close, volume FROM ohlcv_eod WHERE time = :latest_date;"), {"latest_date": latest_date})
    latest_eod = {
        row[0]: {
            "open": float(row[1]) if row[1] is not None else 0.0,
            "high": float(row[2]) if row[2] is not None else 0.0,
            "low": float(row[3]) if row[3] is not None else 0.0,
            "close": float(row[4]) if row[4] is not None else 0.0,
            "volume": int(row[5]) if row[5] is not None else 0
        }
        for row in res.fetchall()
        if row[1] is not None
    }

    # Load EOD data for prev_date
    res = await db.execute(text("SELECT instrument_id, close FROM ohlcv_eod WHERE time = :prev_date;"), {"prev_date": prev_date})
    prev_eod = {row[0]: float(row[1]) for row in res.fetchall() if row[1] is not None}

    # Load last 25 trading days for volume SMA
    res = await db.execute(text("SELECT DISTINCT time FROM ohlcv_eod WHERE time <= :latest_date ORDER BY time DESC LIMIT 25;"), {"latest_date": latest_date})
    last_dates = [r[0] for r in res.fetchall()]
    
    vol_history = {}
    if last_dates:
        dates_params = {f"d_{i}": d for i, d in enumerate(last_dates)}
        dates_placeholders = ", ".join(f":d_{i}" for i in range(len(last_dates)))
        vol_res = await db.execute(
            text(f"SELECT instrument_id, volume FROM ohlcv_eod WHERE time IN ({dates_placeholders});"),
            dates_params
        )
        for r in vol_res.fetchall():
            vol_history.setdefault(r[0], []).append(int(r[1] or 0))

    # Load 52 week highs
    res = await db.execute(text("SELECT DISTINCT time FROM ohlcv_eod WHERE time < :latest_date ORDER BY time DESC LIMIT 252;"), {"latest_date": latest_date})
    year_dates = [r[0] for r in res.fetchall()]
    
    year_highs = {}
    if year_dates:
        year_params = {f"yd_{i}": yd for i, yd in enumerate(year_dates)}
        year_placeholders = ", ".join(f":yd_{i}" for i in range(len(year_dates)))
        high_res = await db.execute(
            text(f"SELECT instrument_id, MAX(high) FROM ohlcv_eod WHERE time IN ({year_placeholders}) GROUP BY instrument_id;"),
            year_params
        )
        year_highs = {r[0]: float(r[1]) for r in high_res.fetchall() if r[1] is not None}

    # Process EQ instruments stats
    advances = 0
    declines = 0
    total = 0
    pos_vol = 0
    neg_vol = 0
    sector_stats = {} # sector: [advances, total]
    sector_volumes = {} # sector: [pos_volume, neg_volume]

    price_vol_list = []
    volume_gainers = []
    near_52w_highs = []
    days_high_list = []

    for inst_id, inst in eq_instruments.items():
        if inst_id not in latest_eod or inst_id not in prev_eod:
            continue
        
        curr = latest_eod[inst_id]
        prev_close = prev_eod[inst_id]
        close = curr["close"]
        high = curr["high"]
        low = curr["low"]
        volume = curr["volume"]
        sector = inst["sector"]

        change_pct = (close - prev_close) / prev_close * 100 if prev_close else 0.0

        total += 1
        if change_pct > 0:
            advances += 1
            pos_vol += volume
            sector_stats.setdefault(sector, [0, 0])[0] += 1
            sector_volumes.setdefault(sector, [0, 0])[0] += volume
        else:
            declines += 1
            neg_vol += volume
            sector_volumes.setdefault(sector, [0, 0])[1] += volume

        sector_stats.setdefault(sector, [0, 0])[1] += 1

        # Price vs Volume
        price_vol_list.append({
            "symbol": inst["symbol"],
            "name": inst["name"],
            "sector": sector,
            "close": close,
            "volume": volume,
            "change_pct": change_pct
        })

        # Volume % Gain compared to 20 SMA
        vols = vol_history.get(inst_id, [])
        if len(vols) >= 20:
            sma_vol = sum(vols[:20]) / 20.0
            if sma_vol > 0:
                vol_gain_pct = (volume - sma_vol) / sma_vol * 100
                volume_gainers.append({
                    "symbol": inst["symbol"],
                    "name": inst["name"],
                    "close": close,
                    "volume": volume,
                    "sma_volume": int(sma_vol),
                    "change_pct": vol_gain_pct
                })

        # Near 52 week high
        if inst_id in year_highs:
            yhigh = year_highs[inst_id]
            if yhigh > 0:
                diff_pct = (close - yhigh) / yhigh * 100
                near_52w_highs.append({
                    "symbol": inst["symbol"],
                    "name": inst["name"],
                    "close": close,
                    "year_high": yhigh,
                    "change_pct": diff_pct
                })

        # Stocks at day's high
        day_range = high - low
        if day_range > 0:
            diff_from_high_pct = (high - close) / close * 100
            days_high_list.append({
                "symbol": inst["symbol"],
                "name": inst["name"],
                "close": close,
                "high": high,
                "low": low,
                "change_pct": diff_from_high_pct
            })

    # Indices stats
    res = await db.execute(text("SELECT id, symbol, name FROM instruments WHERE segment = 'IND' AND is_active = 1;"))
    indices_rows = res.fetchall()
    index_map = {row[0]: {"symbol": row[1], "name": row[2]} for row in indices_rows}
    indices_stats_list = []
    
    if index_map:
        ind_ids_str = ",".join(str(k) for k in index_map.keys())
        latest_ind_res = await db.execute(text(f"SELECT instrument_id, close FROM ohlcv_eod WHERE time = :latest_date AND instrument_id IN ({ind_ids_str});"), {"latest_date": latest_date})
        latest_ind = {row[0]: float(row[1]) for row in latest_ind_res.fetchall() if row[1] is not None}
        
        prev_ind_res = await db.execute(text(f"SELECT instrument_id, close FROM ohlcv_eod WHERE time = :prev_date AND instrument_id IN ({ind_ids_str});"), {"prev_date": prev_date})
        prev_ind = {row[0]: float(row[1]) for row in prev_ind_res.fetchall() if row[1] is not None}

        for ind_id, ind in index_map.items():
            if ind_id in latest_ind and ind_id in prev_ind:
                close = latest_ind[ind_id]
                prev_close = prev_ind[ind_id]
                chg = (close - prev_close) / prev_close * 100 if prev_close else 0.0
                indices_stats_list.append({
                    "symbol": ind["symbol"],
                    "name": ind["name"],
                    "close": close,
                    "change_pct": chg
                })

    # F&O Gainers: get index constituents for Nifty 100
    res = await db.execute(text("SELECT instrument_id FROM index_constituents WHERE index_id = (SELECT id FROM instruments WHERE symbol = 'NIFTY_100' LIMIT 1);"))
    nifty_100_ids = {r[0] for r in res.fetchall()}
    fno_gainers_list = []
    for inst_id in nifty_100_ids:
        if inst_id in eq_instruments and inst_id in latest_eod and inst_id in prev_eod:
            inst = eq_instruments[inst_id]
            close = latest_eod[inst_id]["close"]
            prev_close = prev_eod[inst_id]
            chg = (close - prev_close) / prev_close * 100 if prev_close else 0.0
            fno_gainers_list.append({
                "symbol": inst["symbol"],
                "name": inst["name"],
                "close": close,
                "change_pct": chg
            })

    # Format output lists with sorting
    indices_stats_list = sorted(indices_stats_list, key=lambda x: x["change_pct"], reverse=True)
    volume_gainers = sorted(volume_gainers, key=lambda x: x["change_pct"], reverse=True)[:50]
    price_vol_list = sorted(price_vol_list, key=lambda x: x["volume"], reverse=True)[:50]
    near_52w_highs = sorted(near_52w_highs, key=lambda x: x["change_pct"], reverse=True)[:50]
    fno_gainers_list = sorted(fno_gainers_list, key=lambda x: x["change_pct"], reverse=True)[:50]
    days_high_list = sorted(days_high_list, key=lambda x: x["change_pct"])[:50]

    # Format sector lists
    sector_advances_list = []
    for sec, counts in sector_stats.items():
        sec_adv, sec_tot = counts
        sec_pct = sec_adv / sec_tot * 100 if sec_tot > 0 else 0.0
        vols = sector_volumes.get(sec, [0, 0])
        sector_advances_list.append({
            "sector": sec,
            "advances": sec_adv,
            "total": sec_tot,
            "percentage": round(sec_pct, 2),
            "pos_volume": round(vols[0] / 100000.0, 2),
            "neg_volume": round(vols[1] / 100000.0, 2),
        })
    sector_advances_list = sorted(sector_advances_list, key=lambda x: x["percentage"], reverse=True)

    # Yesterday's volume
    res = await db.execute(text("SELECT SUM(volume) FROM ohlcv_eod WHERE time = :prev_date AND instrument_id IN (SELECT id FROM instruments WHERE segment = 'EQ' AND is_active = 1);"), {"prev_date": prev_date})
    yesterday_volume_sum = res.scalar() or 0

    return {
        "latest_date": latest_date,
        "prev_date": prev_date,
        "market_advances": {
            "advances": advances,
            "declines": declines,
            "total": total,
            "percentage": round(advances / total * 100, 2) if total > 0 else 0.0
        },
        "indices_stats": indices_stats_list,
        "pos_neg_volumes": {
            "positive": round(pos_vol / 100000.0, 2),
            "negative": round(neg_vol / 100000.0, 2)
        },
        "sector_advances": sector_advances_list,
        "volume_gainers": volume_gainers,
        "price_vs_volume": price_vol_list,
        "today_vs_yesterday_volume": {
            "today": round(sum(x["volume"] for x in price_vol_list) / 100000.0, 2),
            "yesterday": round(yesterday_volume_sum / 100000.0, 2)
        },
        "stocks_near_52w_high": near_52w_highs,
        "fno_gainers": fno_gainers_list,
        "stocks_at_days_high": days_high_list
    }


@router.get("/dashboard/4")
async def get_dashboard_4(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    return await get_intraday_desk(db, user)


# ── Scan History ──────────────────────────────────────────────
@router.get("/history")
async def scan_history_list(
    limit: int = Query(50, le=200),
    scan_type: Optional[str] = Query(None),
    include_matches: bool = Query(False),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """The caller's saved scan history, newest first. Each row carries the scan
    type, parameters, result count and the date/time it ran. Pass
    include_matches=true to also return the stored result rows."""
    from sqlalchemy import desc
    from app.models import ScanHistory

    stmt = select(ScanHistory).where(ScanHistory.user_id == user.id)
    if scan_type:
        stmt = stmt.where(ScanHistory.scan_type == scan_type)
    stmt = stmt.order_by(desc(ScanHistory.created_at)).limit(limit)
    rows = (await db.execute(stmt)).scalars().all()

    out = []
    for r in rows:
        item = {
            "id": str(r.id),
            "scan_type": r.scan_type,
            "params": r.params,
            "result_count": r.result_count,
            "created_at": r.created_at.isoformat() if r.created_at else None,
        }
        if include_matches:
            item["matches"] = r.matches
        out.append(item)
    return out

