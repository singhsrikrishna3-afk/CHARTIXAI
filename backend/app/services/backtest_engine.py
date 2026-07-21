"""PEESTOCK — Pattern Backtest Engine.

Empirically measures each pattern type's historical win rate: walk forward
from every past detection and check whether `target_price` or `stop_loss`
was touched first.

Scope note: only pattern types whose detector loops over the *entire*
pivot history (double/triple tops & bottoms, head & shoulders) are
backtestable today. The remaining types (triangles, wedges, rectangles,
harmonics, Wolfe waves, ABC, EW4) only ever surface their single most
recent instance per `detect_all` call — they'd need a rolling re-evaluation
per historical pivot to backtest properly, which is a larger follow-up.
Live confidence for those types stays geometric-fit-based and is labeled
as such in the API/UI.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

import numpy as np
import pandas as pd

from app.services.pattern_engine import PatternEngine, PatternType

BACKTESTABLE_PATTERN_TYPES = {
    PatternType.DOUBLE_TOP,
    PatternType.DOUBLE_BOTTOM,
    PatternType.TRIPLE_TOP,
    PatternType.TRIPLE_BOTTOM,
    PatternType.HEAD_SHOULDERS,
}

# low < LOW_HIGH_CUTOFF[0] <= med < LOW_HIGH_CUTOFF[1] <= high
FIT_TIER_THRESHOLDS = (0.5, 0.75)

MIN_SAMPLE_SIZE = 20  # below this, fall back to geometric-fit confidence


def fit_tier(breakdown: Optional[dict]) -> str:
    """Bucket a pattern instance's geometric sub-scores into low/med/high,
    so the backtest can report a different win rate for a clean vs. sloppy
    instance of the same pattern type."""
    if not breakdown:
        return "unknown"
    avg = sum(breakdown.values()) / len(breakdown)
    if avg < FIT_TIER_THRESHOLDS[0]:
        return "low"
    if avg < FIT_TIER_THRESHOLDS[1]:
        return "med"
    return "high"


@dataclass
class BacktestOutcome:
    pattern_type: str
    tier: str
    win: bool


def _walk_outcome(
    highs: np.ndarray, lows: np.ndarray, entry_idx: int,
    target: Optional[float], stop: Optional[float],
) -> Optional[bool]:
    """Walk forward bar-by-bar from entry_idx+1. Returns True if target is
    touched before stop, False if stop first, None if the data runs out
    before either resolves (excluded from the stat — no forced time limit,
    but an outcome must actually resolve to count)."""
    if target is None or stop is None:
        return None
    entry_price = (highs[entry_idx] + lows[entry_idx]) / 2
    bullish = target > entry_price
    n = len(highs)

    for i in range(entry_idx + 1, n):
        if bullish:
            hit_target = highs[i] >= target
            hit_stop = lows[i] <= stop
        else:
            hit_target = lows[i] <= target
            hit_stop = highs[i] >= stop

        if hit_target and hit_stop:
            # Can't tell which came first intrabar from daily OHLC alone —
            # treat conservatively as a loss rather than guess a win.
            return False
        if hit_target:
            return True
        if hit_stop:
            return False

    return None


def backtest_instrument(df: pd.DataFrame, engine: PatternEngine) -> list[BacktestOutcome]:
    """Detect every historical instance of a backtestable pattern type in
    this instrument's full OHLCV history and score its real outcome."""
    results = engine.detect_all(df, apply_recency_filter=False)
    highs = df["high"].values.astype(float)
    lows = df["low"].values.astype(float)

    outcomes = []
    for r in results:
        if r.pattern_type not in BACKTESTABLE_PATTERN_TYPES or not r.pivots:
            continue
        entry_idx = max(p.index for p in r.pivots)
        win = _walk_outcome(highs, lows, entry_idx, r.target_price, r.stop_loss)
        if win is None:
            continue
        outcomes.append(BacktestOutcome(
            pattern_type=r.pattern_type.value,
            tier=fit_tier(r.confidence_breakdown),
            win=win,
        ))
    return outcomes


def aggregate_outcomes(all_outcomes: list[BacktestOutcome]) -> dict[tuple[str, str], dict]:
    """Roll per-instance outcomes up into win-rate stats per (pattern_type, tier)."""
    buckets: dict[tuple[str, str], dict] = {}
    for o in all_outcomes:
        key = (o.pattern_type, o.tier)
        b = buckets.setdefault(key, {"wins": 0, "losses": 0})
        b["wins" if o.win else "losses"] += 1

    for b in buckets.values():
        total = b["wins"] + b["losses"]
        b["sample_size"] = total
        b["win_rate"] = b["wins"] / total if total else None

    return buckets
