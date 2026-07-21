"""PEESTOCK — No-Code Scanner Execution Engine.

Evaluates user-defined scanner conditions against OHLCV + indicator data.
"""

from __future__ import annotations

from typing import Any

import numpy as np
import pandas as pd


# ── Indicator Computation ────────────────────────────────────
def compute_sma(close: pd.Series, period: int = 20) -> pd.Series:
    return close.rolling(window=period).mean()


def compute_ema(close: pd.Series, period: int = 20) -> pd.Series:
    return close.ewm(span=period, adjust=False).mean()


def compute_rsi(close: pd.Series, period: int = 14) -> pd.Series:
    """Wilder's RSI: gains/losses smoothed with alpha=1/period, matching
    TradingView/Bloomberg convention rather than a simple rolling mean."""
    delta = close.diff()
    gain = delta.where(delta > 0, 0.0).ewm(alpha=1 / period, adjust=False, min_periods=period).mean()
    loss = (-delta.where(delta < 0, 0.0)).ewm(alpha=1 / period, adjust=False, min_periods=period).mean()
    rs = gain / loss.replace(0, np.nan)
    rsi = 100 - (100 / (1 + rs))
    # loss == 0 means pure uptrend over the window -> RSI is 100, not NaN
    rsi = rsi.where(loss != 0, 100.0)
    # no movement at all (gain == 0 and loss == 0) -> neutral RSI
    rsi = rsi.where(~((gain == 0) & (loss == 0)), 50.0)
    return rsi


def compute_macd(close: pd.Series, fast: int = 12, slow: int = 26, signal: int = 9) -> dict[str, pd.Series]:
    ema_fast = close.ewm(span=fast, adjust=False).mean()
    ema_slow = close.ewm(span=slow, adjust=False).mean()
    macd_line = ema_fast - ema_slow
    signal_line = macd_line.ewm(span=signal, adjust=False).mean()
    histogram = macd_line - signal_line
    return {"macd": macd_line, "signal": signal_line, "histogram": histogram}


def compute_slope(series: pd.Series, period: int = 5) -> pd.Series:
    """Slope as % change over period."""
    return (series - series.shift(period)) / series.shift(period) * 100


def compute_atr(df: pd.DataFrame, period: int = 14) -> pd.Series:
    """Wilder's ATR: true range smoothed with alpha=1/period. A plain rolling
    mean understates ATR in trending markets and mismatches the DI smoothing
    used in compute_adx, which would otherwise make ADX internally inconsistent."""
    high_low = df['high'] - df['low']
    high_close = np.abs(df['high'] - df['close'].shift())
    low_close = np.abs(df['low'] - df['close'].shift())
    ranges = pd.concat([high_low, high_close, low_close], axis=1)
    true_range = np.max(ranges, axis=1)
    return true_range.ewm(alpha=1 / period, adjust=False, min_periods=period).mean()


def compute_bbands(close: pd.Series, period: int = 20, std_dev: float = 2.0) -> dict[str, pd.Series]:
    sma = close.rolling(period).mean()
    std = close.rolling(period).std()
    upper = sma + (std * std_dev)
    lower = sma - (std * std_dev)
    bandwidth = (upper - lower) / sma
    return {"upper": upper, "lower": lower, "sma": sma, "bandwidth": bandwidth}


def compute_supertrend(df: pd.DataFrame, period: int = 10, multiplier: float = 3.0) -> dict[str, pd.Series]:
    # SuperTrend is inherently sequential (each bar's band depends on the
    # previous bar's decision), so the loop itself can't be vectorized away —
    # but indexing was happening through `.iloc[i]` on pandas Series inside
    # a tight Python loop, which is far slower than plain numpy array
    # indexing. Pulling everything to .values first is what actually
    # matters for the 500+ stock scan workload this runs under.
    atr = compute_atr(df, period).values
    hl2 = ((df['high'] + df['low']) / 2).values
    basic_ub = hl2 + (multiplier * atr)
    basic_lb = hl2 - (multiplier * atr)

    n = len(df)
    final_ub = np.zeros(n)
    final_lb = np.zeros(n)
    trend = np.zeros(n)

    close = df['close'].values

    for i in range(period, n):
        if basic_ub[i] < final_ub[i-1] or close[i-1] > final_ub[i-1]:
            final_ub[i] = basic_ub[i]
        else:
            final_ub[i] = final_ub[i-1]

        if basic_lb[i] > final_lb[i-1] or close[i-1] < final_lb[i-1]:
            final_lb[i] = basic_lb[i]
        else:
            final_lb[i] = final_lb[i-1]

        if close[i] > final_ub[i-1]:
            trend[i] = 1
        elif close[i] < final_lb[i-1]:
            trend[i] = -1
        else:
            trend[i] = trend[i-1]

    supertrend = np.where(trend == 1, final_lb, final_ub)
    return {"supertrend": pd.Series(supertrend, index=df.index), "trend": pd.Series(trend, index=df.index)}


def compute_adx(df: pd.DataFrame, period: int = 14) -> dict[str, pd.Series]:
    high = df['high']
    low = df['low']
    
    plus_dm = high.diff()
    minus_dm = low.diff()
    plus_dm[plus_dm < 0] = 0
    minus_dm[minus_dm > 0] = 0
    minus_dm = minus_dm.abs()
    
    plus_dm_series = np.where(plus_dm > minus_dm, plus_dm, 0)
    minus_dm_series = np.where(minus_dm > plus_dm, minus_dm, 0)
    
    atr = compute_atr(df, period)
    
    plus_di = 100 * (pd.Series(plus_dm_series, index=df.index).ewm(alpha=1/period, adjust=False).mean() / atr)
    minus_di = 100 * (pd.Series(minus_dm_series, index=df.index).ewm(alpha=1/period, adjust=False).mean() / atr)
    
    dx = 100 * np.abs(plus_di - minus_di) / (plus_di + minus_di)
    adx = dx.ewm(alpha=1/period, adjust=False).mean()
    
    return {"adx": pd.Series(adx, index=df.index), "plus_di": plus_di, "minus_di": minus_di}


def compute_ichimoku(df: pd.DataFrame, tenkan: int = 9, kijun: int = 26, senkou: int = 52) -> dict[str, pd.Series]:
    high_9 = df['high'].rolling(window=tenkan).max()
    low_9 = df['low'].rolling(window=tenkan).min()
    tenkan_sen = (high_9 + low_9) / 2
    
    high_26 = df['high'].rolling(window=kijun).max()
    low_26 = df['low'].rolling(window=kijun).min()
    kijun_sen = (high_26 + low_26) / 2
    
    senkou_span_a = ((tenkan_sen + kijun_sen) / 2).shift(kijun)
    
    high_52 = df['high'].rolling(window=senkou).max()
    low_52 = df['low'].rolling(window=senkou).min()
    senkou_span_b = ((high_52 + low_52) / 2).shift(kijun)
    
    return {
        "tenkan": tenkan_sen,
        "kijun": kijun_sen,
        "senkou_a": senkou_span_a,
        "senkou_b": senkou_span_b
    }


def compute_nr7(df: pd.DataFrame) -> pd.Series:
    range_ = df['high'] - df['low']
    min_range = range_.rolling(7).min()
    return (range_ == min_range).astype(int)


def compute_inside_bar(df: pd.DataFrame) -> pd.Series:
    prev_high = df['high'].shift(1)
    prev_low = df['low'].shift(1)
    inside = (df['high'] < prev_high) & (df['low'] > prev_low)
    return inside.astype(int)


def compute_gap_up(df: pd.DataFrame, min_percent: float = 0.5) -> pd.Series:
    prev_high = df['high'].shift(1)
    curr_low = df['low']
    gap_pct = ((curr_low - prev_high) / prev_high) * 100
    return (gap_pct >= min_percent).astype(int)


def compute_gap_down(df: pd.DataFrame, min_percent: float = 0.5) -> pd.Series:
    prev_low = df['low'].shift(1)
    curr_high = df['high']
    gap_pct = ((prev_low - curr_high) / prev_low) * 100
    return (gap_pct >= min_percent).astype(int)


def compute_stochastic(df: pd.DataFrame, k_period: int = 14, d_period: int = 3) -> dict[str, pd.Series]:
    low_min = df['low'].rolling(window=k_period).min()
    high_max = df['high'].rolling(window=k_period).max()
    rng = high_max - low_min
    # Flat range (no movement over the window) makes %K undefined; convention
    # is to treat the close as sitting mid-range rather than emit inf/NaN.
    k = 100 * ((df['close'] - low_min) / rng.replace(0, np.nan))
    k = k.where(rng != 0, 50.0)
    d = k.rolling(window=d_period).mean()
    return {"k": k, "d": d}


def compute_vwap(df: pd.DataFrame) -> pd.Series:
    q = df['volume']
    p = (df['high'] + df['low'] + df['close']) / 3
    return (p * q).cumsum() / q.cumsum()


def compute_doji(df: pd.DataFrame) -> pd.Series:
    body = (df['close'] - df['open']).abs()
    hl_range = df['high'] - df['low']
    return (body <= (hl_range * 0.1)).astype(int)


def compute_hammer(df: pd.DataFrame) -> pd.Series:
    body = (df['close'] - df['open']).abs()
    lower_shadow = np.where(df['close'] > df['open'], df['open'] - df['low'], df['close'] - df['low'])
    upper_shadow = np.where(df['close'] > df['open'], df['high'] - df['close'], df['high'] - df['open'])
    hl_range = df['high'] - df['low']
    return ((lower_shadow > 2 * body) & (upper_shadow < 0.1 * hl_range)).astype(int)


def compute_engulfing(df: pd.DataFrame) -> pd.Series:
    prev_open = df['open'].shift(1)
    prev_close = df['close'].shift(1)
    curr_open = df['open']
    curr_close = df['close']
    bullish = (prev_close < prev_open) & (curr_close > curr_open) & (curr_open <= prev_close) & (curr_close >= prev_open)
    bearish = (prev_close > prev_open) & (curr_close < curr_open) & (curr_open >= prev_close) & (curr_close <= prev_open)
    return pd.Series(np.where(bullish, 1, np.where(bearish, -1, 0)), index=df.index)


def compute_psar(df: pd.DataFrame, step: float = 0.02, max_step: float = 0.2) -> dict[str, pd.Series]:
    """Wilder's Parabolic Stop-and-Reverse (the real PSAR formula, distinct from Supertrend)."""
    high, low = df['high'].values, df['low'].values
    n = len(df)
    sar = np.zeros(n)
    trend = np.ones(n)
    if n == 0:
        return {"sar": pd.Series(sar, index=df.index), "trend": pd.Series(trend, index=df.index)}

    bull = True
    af = step
    hp, lp = high[0], low[0]
    sar[0] = low[0]

    for i in range(1, n):
        ep = hp if bull else lp
        sar[i] = sar[i - 1] + af * (ep - sar[i - 1])
        reverse = False

        if bull:
            if low[i] < sar[i]:
                bull, reverse = False, True
                sar[i] = hp
                lp, af = low[i], step
        else:
            if high[i] > sar[i]:
                bull, reverse = True, True
                sar[i] = lp
                hp, af = high[i], step

        if not reverse:
            if bull:
                if high[i] > hp:
                    hp = high[i]
                    af = min(af + step, max_step)
                sar[i] = min(sar[i], low[i - 1], low[i - 2] if i >= 2 else low[i - 1])
            else:
                if low[i] < lp:
                    lp = low[i]
                    af = min(af + step, max_step)
                sar[i] = max(sar[i], high[i - 1], high[i - 2] if i >= 2 else high[i - 1])

        trend[i] = 1 if bull else -1

    return {"sar": pd.Series(sar, index=df.index), "trend": pd.Series(trend, index=df.index)}


def compute_hl_sar(df: pd.DataFrame, period: int = 21) -> dict[str, pd.Series]:
    """High-Low based SAR: a channel trailing-stop that flips using the rolling
    high/low extremes of the lookback window (generic Donchian-style stop-and-reverse).

    Like compute_supertrend, the flip logic is inherently sequential, but
    converting the rolling windows and OHLC to numpy arrays first avoids
    `.iloc[i]` / `pd.isna()` calls on pandas Series inside the loop, which
    dominate the runtime at scan-engine scale (500+ stocks per tick)."""
    high, low, close = df['high'].values, df['low'].values, df['close'].values
    roll_low = df['low'].rolling(period).min().values
    roll_high = df['high'].rolling(period).max().values
    n = len(df)
    sar = np.zeros(n)
    trend = np.ones(n)
    sar[0] = roll_low[0] if not np.isnan(roll_low[0]) else low[0]

    for i in range(1, n):
        if trend[i - 1] == 1:
            level = roll_low[i]
            sar[i] = max(sar[i - 1], level) if not np.isnan(level) else sar[i - 1]
            if close[i] < sar[i]:
                trend[i] = -1
                sar[i] = roll_high[i] if not np.isnan(roll_high[i]) else high[i]
            else:
                trend[i] = 1
        else:
            level = roll_high[i]
            sar[i] = min(sar[i - 1], level) if not np.isnan(level) else sar[i - 1]
            if close[i] > sar[i]:
                trend[i] = 1
                sar[i] = roll_low[i] if not np.isnan(roll_low[i]) else low[i]
            else:
                trend[i] = -1

    return {"sar": pd.Series(sar, index=df.index), "trend": pd.Series(trend, index=df.index)}


def compute_ma_oscillator(close: pd.Series, fast: int = 10, slow: int = 20, ma_type: str = "EMA") -> pd.Series:
    """Oscillator = % difference between a fast and slow moving average."""
    if ma_type.upper() == "SMA":
        fast_ma, slow_ma = compute_sma(close, fast), compute_sma(close, slow)
    else:
        fast_ma, slow_ma = compute_ema(close, fast), compute_ema(close, slow)
    return (fast_ma - slow_ma) / slow_ma * 100


def compute_ma_band(close: pd.Series, period: int = 20, band_pct: float = 2.5, ma_type: str = "SMA") -> dict[str, pd.Series]:
    """Moving average envelope: a fixed-% band offset above/below a base MA."""
    basis = compute_sma(close, period) if ma_type.upper() == "SMA" else compute_ema(close, period)
    upper = basis * (1 + band_pct / 100)
    lower = basis * (1 - band_pct / 100)
    return {"basis": basis, "upper": upper, "lower": lower}


def compute_heikin_ashi(df: pd.DataFrame) -> pd.DataFrame:
    """Heikin-Ashi smoothed candles, with a per-bar trend flag (1 bullish / -1 bearish)."""
    ha_close = (df['open'] + df['high'] + df['low'] + df['close']) / 4
    ha_open = np.zeros(len(df))
    ha_open[0] = (df['open'].iloc[0] + df['close'].iloc[0]) / 2
    for i in range(1, len(df)):
        ha_open[i] = (ha_open[i - 1] + ha_close.iloc[i - 1]) / 2
    ha_open = pd.Series(ha_open, index=df.index)
    ha_high = pd.concat([df['high'], ha_open, ha_close], axis=1).max(axis=1)
    ha_low = pd.concat([df['low'], ha_open, ha_close], axis=1).min(axis=1)
    trend = np.where(ha_close > ha_open, 1, -1)
    return pd.DataFrame({
        "open": ha_open, "high": ha_high, "low": ha_low, "close": ha_close,
        "trend": pd.Series(trend, index=df.index),
    })


INDICATOR_FUNCTIONS = {
    "sma": compute_sma,
    "ema": compute_ema,
    "rsi": compute_rsi,
    "macd": compute_macd,
}


# ── Condition Evaluator ─────────────────────────────────────
def _get_indicator_series(df: pd.DataFrame, indicator: str, params: dict) -> pd.Series:
    """Compute an indicator series from the DataFrame."""
    close = df["close"]

    if indicator == "price":
        return close
    elif indicator == "volume":
        return df["volume"].astype(float)
    elif indicator in ("sma", "ema"):
        period = params.get("period", 20)
        return INDICATOR_FUNCTIONS[indicator](close, period)
    elif indicator == "rsi":
        period = params.get("period", 14)
        return compute_rsi(close, period)
    elif indicator == "macd":
        result = compute_macd(
            close,
            fast=params.get("fast", 12),
            slow=params.get("slow", 26),
            signal=params.get("signal", 9),
        )
        component = params.get("component", "macd")
        return result[component]
    elif indicator == "slope":
        # Slope of another indicator
        base_indicator = params.get("of", "sma")
        base_params = params.get("of_params", {"period": 20})
        base_series = _get_indicator_series(df, base_indicator, base_params)
        return compute_slope(base_series, params.get("period", 5))
    elif indicator == "high_n":
        n = params.get("n", 20)
        return df["high"].rolling(n).max()
    elif indicator == "low_n":
        n = params.get("n", 20)
        return df["low"].rolling(n).min()
    elif indicator == "bbands":
        result = compute_bbands(close, period=params.get("period", 20), std_dev=params.get("std_dev", 2.0))
        component = params.get("component", "bandwidth")
        return result[component]
    elif indicator == "supertrend":
        result = compute_supertrend(df, period=params.get("period", 10), multiplier=params.get("multiplier", 3.0))
        component = params.get("component", "trend")
        return result[component]
    elif indicator == "adx":
        result = compute_adx(df, period=params.get("period", 14))
        component = params.get("component", "adx")
        return result[component]
    elif indicator == "ichimoku":
        result = compute_ichimoku(df, tenkan=params.get("tenkan", 9), kijun=params.get("kijun", 26), senkou=params.get("senkou", 52))
        component = params.get("component", "tenkan")
        return result[component]
    elif indicator == "nr7":
        return compute_nr7(df)
    elif indicator == "inside_bar":
        return compute_inside_bar(df)
    elif indicator == "gap_up":
        return compute_gap_up(df, min_percent=params.get("min_percent", 0.5))
    elif indicator == "gap_down":
        return compute_gap_down(df, min_percent=params.get("min_percent", 0.5))
    elif indicator == "atr":
        return compute_atr(df, period=params.get("period", 14))
    elif indicator == "stochastic":
        result = compute_stochastic(df, k_period=params.get("period", 14), d_period=3)
        component = params.get("component", "k")
        return result[component]
    elif indicator == "vwap":
        return compute_vwap(df)
    elif indicator == "doji":
        return compute_doji(df)
    elif indicator == "hammer":
        return compute_hammer(df)
    elif indicator == "engulfing":
        return compute_engulfing(df)
    else:
        raise ValueError(f"Unknown indicator: {indicator}")


def evaluate_condition(df: pd.DataFrame, condition: dict) -> bool:
    """Evaluate a single scanner condition on the latest bar.

    Returns True if the condition is met on the most recent bar.
    """
    indicator = condition["indicator"]
    params = condition.get("params", {})
    operator = condition["operator"]

    series_a = _get_indicator_series(df, indicator, params)

    # Get comparison value
    if condition.get("compare_to"):
        series_b = _get_indicator_series(
            df, condition["compare_to"]["indicator"],
            condition["compare_to"].get("params", {}),
        )
    else:
        value = condition.get("value", 0)
        series_b = pd.Series(value, index=df.index)

    # Evaluate operator on the last bar
    idx = -1
    a = series_a.iloc[idx] if not pd.isna(series_a.iloc[idx]) else None
    b = series_b.iloc[idx] if not pd.isna(series_b.iloc[idx]) else None

    if a is None or b is None:
        return False

    if operator in ("gt", "above"):
        return a > b
    elif operator in ("lt", "below"):
        return a < b
    elif operator in ("gte", "above_or_equal"):
        return a >= b
    elif operator in ("lte", "below_or_equal"):
        return a <= b
    elif operator == "eq":
        return abs(a - b) < 0.001
    elif operator in ("crosses_above", "crosses_below"):
        # Match a cross that happened within the last `within_bars` bars, not only
        # on the exact latest bar. A 50/200 golden cross is a once-in-months event
        # per stock; requiring it on today's bar alone makes the scan almost always
        # empty. A short recency window ("recently crossed") is what traders want.
        if len(series_a) < 2:
            return False
        within = max(1, int(params.get("within_bars", 5)))
        pa, pb = series_a.shift(1), series_b.shift(1)
        if operator == "crosses_above":
            crossed = (pa <= pb) & (series_a > series_b)
        else:
            crossed = (pa >= pb) & (series_a < series_b)
        return bool(crossed.iloc[-within:].fillna(False).any())
    elif operator == "slope_up":
        return compute_slope(series_a, params.get("slope_period", 5)).iloc[-1] > 0
    elif operator == "slope_down":
        return compute_slope(series_a, params.get("slope_period", 5)).iloc[-1] < 0
    else:
        raise ValueError(f"Unknown operator: {operator}")


def run_scanner(df: pd.DataFrame, conditions: list[dict], logic: str = "AND") -> bool:
    """Run all conditions against a stock's OHLCV DataFrame.

    Args:
        df: OHLCV DataFrame.
        conditions: List of condition dicts.
        logic: "AND" or "OR".

    Returns:
        True if the stock passes the scanner.
    """
    results = [evaluate_condition(df, c) for c in conditions]

    if logic == "AND":
        return all(results)
    elif logic == "OR":
        return any(results)
    return False
