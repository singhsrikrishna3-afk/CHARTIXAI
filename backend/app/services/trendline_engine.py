"""PEESTOCK — Automated Trendline Engine.

Computes support/resistance trendlines from pivot points.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

import numpy as np
import pandas as pd


@dataclass
class TrendlineResult:
    line_type: str  # 'support', 'resistance'
    slope: float
    intercept: float
    point_a_idx: int
    point_a_price: float
    point_b_idx: int
    point_b_price: float
    touches: int
    strength: float  # 0-1 score


class TrendlineEngine:
    """Automatically detect trendlines from OHLCV data."""

    def __init__(self, pivot_lookback: int = 5, touch_tolerance: float = 0.005, max_pivots: int = 60):
        self.pivot_lookback = pivot_lookback
        self.touch_tolerance = touch_tolerance
        # Pivot pairs scale O(P^2), so cap to the most recent pivots — old
        # trendlines from years back are rarely still relevant anyway.
        self.max_pivots = max_pivots

    def detect(self, df: pd.DataFrame) -> list[TrendlineResult]:
        """Detect support and resistance trendlines."""
        if len(df) < 30:
            return []

        highs = df["high"].values.astype(float)
        lows = df["low"].values.astype(float)

        pivot_highs = self._find_pivots(highs, is_high=True)
        pivot_lows = self._find_pivots(lows, is_high=False)

        results = []
        results.extend(self._fit_trendlines(pivot_highs, highs, "resistance"))
        results.extend(self._fit_trendlines(pivot_lows, lows, "support"))

        # Sort by strength
        results.sort(key=lambda x: x.strength, reverse=True)
        return results[:10]  # Top 10 trendlines

    def _find_pivots(self, data: np.ndarray, is_high: bool) -> list[tuple[int, float]]:
        pivots = []
        lb = self.pivot_lookback
        for i in range(lb, len(data) - lb):
            if is_high:
                if data[i] == max(data[i - lb: i + lb + 1]):
                    pivots.append((i, data[i]))
            else:
                if data[i] == min(data[i - lb: i + lb + 1]):
                    pivots.append((i, data[i]))
        return pivots

    def _fit_trendlines(
        self, pivots: list[tuple[int, float]], data: np.ndarray, line_type: str
    ) -> list[TrendlineResult]:
        results = []
        if len(pivots) < 2:
            return results

        pivots = pivots[-self.max_pivots:]
        k = np.arange(len(data))

        for i in range(len(pivots)):
            for j in range(i + 1, len(pivots)):
                idx_a, price_a = pivots[i]
                idx_b, price_b = pivots[j]

                if idx_b - idx_a < 5:
                    continue

                slope = (price_b - price_a) / (idx_b - idx_a)
                intercept = price_a - slope * idx_a

                # Determine if horizontal (within 2% price difference)
                is_horizontal = abs(price_b - price_a) / max(price_a, 1) < 0.02
                
                if is_horizontal:
                    slope = 0
                    intercept = (price_a + price_b) / 2
                    price_a_final = intercept
                    price_b_final = intercept
                    final_type = "support" if line_type == "support" else "resistance"
                else:
                    price_a_final = price_a
                    price_b_final = price_b
                    # Trendlines must make sense (uptrend = higher lows, downtrend = lower highs)
                    if line_type == "support" and slope > 0:
                        final_type = "uptrend"
                    elif line_type == "resistance" and slope < 0:
                        final_type = "downtrend"
                    else:
                        continue # Skip angled lines that don't fit the definition

                # Count touches (vectorized — this is the hot inner loop)
                expected = slope * k + intercept
                touches = int(np.sum(np.abs(data - expected) / np.maximum(expected, 1) < self.touch_tolerance))

                if touches >= 2:
                    # Strength based on touches and recency
                    recency_score = min(1.0, (idx_b / len(data)))
                    strength = min(1.0, (touches / 5) * 0.6 + recency_score * 0.4)

                    results.append(TrendlineResult(
                        line_type=final_type,
                        slope=slope,
                        intercept=intercept,
                        point_a_idx=idx_a,
                        point_a_price=price_a_final,
                        point_b_idx=idx_b,
                        point_b_price=price_b_final,
                        touches=touches,
                        strength=strength,
                    ))

        return results

    def classify_action(self, df: pd.DataFrame, trendlines: list[TrendlineResult]) -> dict:
        """Classify current price action relative to trendlines.

        Returns dict with keys: 'finding_support', 'facing_resistance', 'breaking_out'
        """
        if not trendlines or len(df) == 0:
            return {"finding_support": [], "facing_resistance": [], "breaking_out": []}

        current_idx = len(df) - 1
        current_close = float(df["close"].iloc[-1])
        prev_close = float(df["close"].iloc[-2]) if len(df) > 1 else current_close

        support = []
        resistance = []
        breakout = []

        for tl in trendlines:
            expected = tl.slope * current_idx + tl.intercept
            distance = (current_close - expected) / expected

            if tl.line_type == "support":
                if abs(distance) < 0.01:
                    support.append(tl)
                elif prev_close > expected and current_close < expected:
                    breakout.append(("breakdown", tl))
            elif tl.line_type == "resistance":
                if abs(distance) < 0.01:
                    resistance.append(tl)
                elif prev_close < expected and current_close > expected:
                    breakout.append(("breakout", tl))

        return {
            "finding_support": support,
            "facing_resistance": resistance,
            "breaking_out": breakout,
        }
