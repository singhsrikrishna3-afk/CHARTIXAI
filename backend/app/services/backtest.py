"""Chartix — strategy backtesting engine.

Backtests a no-code scanner (the same condition trees used by /scanners) against
historical OHLCV, entering long when the scanner fires and exiting on a stop-loss
or profit target (with a max-holding-bars safety cap).

Reuses `scanner_engine._get_indicator_series` and mirrors `evaluate_condition`'s
operator semantics *vectorised* — so the entry signal computed here matches what
the live scanner would have flagged on each historical bar, at O(bars) per
instrument instead of O(bars²).
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from app.services.scanner_engine import _get_indicator_series, compute_slope


# ── Entry signal (vectorised scanner) ─────────────────────────────────────────
def _condition_series(df: pd.DataFrame, condition: dict) -> pd.Series:
    """Boolean series: is this single condition true on each bar? Mirrors
    scanner_engine.evaluate_condition operator-for-operator."""
    indicator = condition["indicator"]
    params = condition.get("params", {})
    operator = condition["operator"]

    a = _get_indicator_series(df, indicator, params).astype(float)
    if condition.get("compare_to"):
        b = _get_indicator_series(
            df, condition["compare_to"]["indicator"],
            condition["compare_to"].get("params", {}),
        ).astype(float)
    else:
        b = pd.Series(float(condition.get("value", 0)), index=df.index)

    if operator in ("gt", "above"):
        res = a > b
    elif operator in ("lt", "below"):
        res = a < b
    elif operator in ("gte", "above_or_equal"):
        res = a >= b
    elif operator in ("lte", "below_or_equal"):
        res = a <= b
    elif operator == "eq":
        res = (a - b).abs() < 0.001
    elif operator == "crosses_above":
        res = (a.shift(1) <= b.shift(1)) & (a > b)
    elif operator == "crosses_below":
        res = (a.shift(1) >= b.shift(1)) & (a < b)
    elif operator == "slope_up":
        res = compute_slope(a, params.get("slope_period", 5)) > 0
    elif operator == "slope_down":
        res = compute_slope(a, params.get("slope_period", 5)) < 0
    else:
        raise ValueError(f"Unknown operator: {operator}")

    # NaN comparisons → False, matching evaluate_condition's None handling.
    return res.reindex(df.index).fillna(False).astype(bool)


def entry_signal(df: pd.DataFrame, conditions: list[dict], logic: str = "AND") -> pd.Series:
    """Combine all conditions into one boolean entry-signal series."""
    if not conditions:
        return pd.Series(False, index=df.index)
    series = [_condition_series(df, c) for c in conditions]
    combined = series[0].copy()
    for s in series[1:]:
        combined = (combined & s) if logic == "AND" else (combined | s)
    return combined


# ── Trade simulation ──────────────────────────────────────────────────────────
def simulate_trades(
    df: pd.DataFrame,
    signal: pd.Series,
    stop_loss_pct: float,
    target_pct: float,
    max_holding_bars: int,
) -> list[dict]:
    """Long-only simulation. Enter at the *next* bar's open after a signal (no
    look-ahead); exit at stop, target, or the holding cap. No overlapping trades."""
    o = df["open"].to_numpy(dtype=float)
    h = df["high"].to_numpy(dtype=float)
    l = df["low"].to_numpy(dtype=float)
    c = df["close"].to_numpy(dtype=float)
    t = df["time"].to_numpy()
    sig = signal.to_numpy(dtype=bool)
    n = len(df)

    trades: list[dict] = []
    i = 0
    while i < n - 1:
        if not sig[i]:
            i += 1
            continue

        entry_idx = i + 1
        entry_price = o[entry_idx]
        if not np.isfinite(entry_price) or entry_price <= 0:
            i += 1
            continue

        stop_price = entry_price * (1 - stop_loss_pct / 100.0)
        target_price = entry_price * (1 + target_pct / 100.0)

        exit_idx = None
        exit_price = None
        reason = None
        last = min(entry_idx + max_holding_bars, n - 1)
        for j in range(entry_idx, last + 1):
            # Conservative: if a bar spans both, assume the stop filled first.
            if l[j] <= stop_price:
                exit_idx, exit_price, reason = j, stop_price, "stop"
                break
            if h[j] >= target_price:
                exit_idx, exit_price, reason = j, target_price, "target"
                break
        if exit_idx is None:
            exit_idx, exit_price, reason = last, c[last], "timeout"

        ret = (exit_price - entry_price) / entry_price * 100.0
        trades.append({
            "entry_date": str(t[entry_idx])[:10],
            "exit_date": str(t[exit_idx])[:10],
            "entry_price": round(float(entry_price), 2),
            "exit_price": round(float(exit_price), 2),
            "return_pct": round(float(ret), 2),
            "bars_held": int(exit_idx - entry_idx),
            "exit_reason": reason,
        })
        i = exit_idx + 1  # positions never overlap

    return trades


# ── Metrics ───────────────────────────────────────────────────────────────────
def compute_metrics(trades: list[dict], sequential: bool = True) -> dict:
    """Per-trade statistics for a set of trades.

    `sequential=True` (a single instrument — positions never overlap) additionally
    reports a compounded equity total return and max drawdown. For a pooled basket
    the trades overlap in time across symbols, so sequential compounding would be
    meaningless; pass `sequential=False` and those two fields come back as None (the
    orchestrator reports an average-per-symbol return instead)."""
    n = len(trades)
    base = {"num_trades": 0, "win_rate_pct": 0.0, "avg_return_pct": 0.0,
            "total_return_pct": None, "max_drawdown_pct": None, "profit_factor": None,
            "avg_win_pct": 0.0, "avg_loss_pct": 0.0, "avg_bars_held": 0.0}
    if n == 0:
        return base

    rets = [t["return_pct"] for t in trades]
    wins = [r for r in rets if r > 0]
    losses = [r for r in rets if r <= 0]
    gross_win = sum(wins)
    gross_loss = abs(sum(losses))

    total_return = None
    max_dd = None
    if sequential:
        equity = 1.0
        peak = 1.0
        max_dd = 0.0
        for r in rets:
            equity *= (1 + r / 100.0)
            peak = max(peak, equity)
            max_dd = min(max_dd, (equity - peak) / peak * 100.0)
        total_return = round((equity - 1) * 100, 2)
        max_dd = round(max_dd, 2)

    return {
        "num_trades": n,
        "win_rate_pct": round(len(wins) / n * 100, 1),
        "avg_return_pct": round(float(np.mean(rets)), 2),
        "total_return_pct": total_return,
        "max_drawdown_pct": max_dd,
        "profit_factor": round(gross_win / gross_loss, 2) if gross_loss > 0 else None,
        "avg_win_pct": round(float(np.mean(wins)), 2) if wins else 0.0,
        "avg_loss_pct": round(float(np.mean(losses)), 2) if losses else 0.0,
        "avg_bars_held": round(float(np.mean([t["bars_held"] for t in trades])), 1),
    }


# ── Orchestration ─────────────────────────────────────────────────────────────
async def run_backtest(
    db,
    conditions: list[dict],
    logic: str,
    instruments: list,
    timeframe: str = "D",
    stop_loss_pct: float = 5.0,
    target_pct: float = 10.0,
    max_holding_bars: int = 60,
    lookback_bars: int = 1500,
) -> dict:
    """Backtest `conditions` across the given instruments. Returns portfolio-level
    metrics (all trades pooled, equal-weight), a per-symbol breakdown, and a
    capped sample of trades."""
    from app.api.scans import _load_df  # lazy import to avoid circular import

    all_trades: list[dict] = []
    per_symbol: list[dict] = []
    skipped = 0

    for instr in instruments:
        df = await _load_df(db, instr.id, timeframe, limit=lookback_bars)
        if df is None or len(df) < 30:
            skipped += 1
            continue
        try:
            sig = entry_signal(df, conditions, logic)
            trades = simulate_trades(df, sig, stop_loss_pct, target_pct, max_holding_bars)
        except ValueError:
            raise
        except Exception:
            skipped += 1
            continue

        for tr in trades:
            tr["symbol"] = instr.symbol
        all_trades.extend(trades)
        if trades:
            m = compute_metrics(trades, sequential=True)  # per-symbol: no overlap
            per_symbol.append({"symbol": instr.symbol, **{k: m[k] for k in
                              ("num_trades", "win_rate_pct", "avg_return_pct", "total_return_pct")}})

    all_trades.sort(key=lambda x: x["entry_date"])
    single = len(instruments) == 1
    summary = compute_metrics(all_trades, sequential=single)
    if not single:
        # Trades across a basket overlap in time; report the average of each
        # symbol's own compounded return instead of a bogus pooled compound.
        sym_totals = [s["total_return_pct"] for s in per_symbol if s["total_return_pct"] is not None]
        summary["avg_symbol_return_pct"] = round(float(np.mean(sym_totals)), 2) if sym_totals else 0.0
        summary["symbols_with_trades"] = len(per_symbol)
    per_symbol.sort(key=lambda x: (x["total_return_pct"] is not None, x["total_return_pct"]), reverse=True)

    return {
        "summary": summary,
        "params": {
            "timeframe": timeframe, "stop_loss_pct": stop_loss_pct,
            "target_pct": target_pct, "max_holding_bars": max_holding_bars,
            "instruments_tested": len(instruments), "instruments_skipped": skipped,
        },
        "per_symbol": per_symbol[:100],
        "trades": all_trades[-200:],  # most recent 200 for the trade log
    }
