"""PEESTOCK — Pattern Detection Engine.

Detects chart patterns on OHLCV data using pivot point analysis.
Supports: Double/Triple Tops/Bottoms, H&S, Triangles, Wedges,
Flags, Pennants, Harmonics, Rectangles, Wolfe Waves, ABC/EW patterns.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Optional

import numpy as np
import pandas as pd


class PatternType(str, Enum):
    DOUBLE_TOP = "double_top"
    DOUBLE_BOTTOM = "double_bottom"
    TRIPLE_TOP = "triple_top"
    TRIPLE_BOTTOM = "triple_bottom"
    HEAD_SHOULDERS = "head_shoulders"
    INV_HEAD_SHOULDERS = "inv_head_shoulders"
    ASC_TRIANGLE = "asc_triangle"
    DESC_TRIANGLE = "desc_triangle"
    SYM_TRIANGLE = "sym_triangle"
    RISING_WEDGE = "rising_wedge"
    FALLING_WEDGE = "falling_wedge"
    BULL_FLAG = "bull_flag"
    BEAR_FLAG = "bear_flag"
    PENNANT = "pennant"
    RECTANGLE = "rectangle"
    WOLFE_WAVE = "wolfe_wave"
    HARMONIC = "harmonic"
    ABC_PATTERN = "abc_pattern"
    EW_4TH_WAVE = "ew_4th_wave"


@dataclass
class PivotPoint:
    index: int
    price: float
    time: object
    is_high: bool


@dataclass
class DetectedPatternResult:
    pattern_type: PatternType
    confidence: float
    pivots: list[PivotPoint] = field(default_factory=list)
    target_price: Optional[float] = None
    stop_loss: Optional[float] = None
    status: str = "forming"


class PatternEngine:
    """Core pattern detection engine operating on OHLCV DataFrames."""

    def __init__(self, pivot_lookback: int = 5, tolerance: float = 0.02):
        self.pivot_lookback = pivot_lookback
        self.tolerance = tolerance  # % tolerance for price level matching

    def detect_all(self, df: pd.DataFrame) -> list[DetectedPatternResult]:
        """Run all pattern detectors on the given OHLCV DataFrame.

        Args:
            df: DataFrame with columns [time, open, high, low, close, volume]

        Returns:
            List of detected pattern results.
        """
        if len(df) < 30:
            return []

        highs = df["high"].values.astype(float)
        lows = df["low"].values.astype(float)
        closes = df["close"].values.astype(float)
        volumes = df["volume"].values.astype(float) if "volume" in df.columns else None
        times = df["time"].values

        # Find pivot highs and lows
        pivot_highs = self._find_pivots(highs, is_high=True)
        pivot_lows = self._find_pivots(lows, is_high=False)

        # Attach time info
        for p in pivot_highs:
            p.time = times[p.index]
        for p in pivot_lows:
            p.time = times[p.index]

        results = []

        # Run each detector
        results.extend(self._detect_double_tops(pivot_highs, closes))
        results.extend(self._detect_double_bottoms(pivot_lows, closes))
        results.extend(self._detect_triple_tops(pivot_highs, closes))
        results.extend(self._detect_triple_bottoms(pivot_lows, closes))
        results.extend(self._detect_head_shoulders(pivot_highs, pivot_lows, closes))
        results.extend(self._detect_triangles(pivot_highs, pivot_lows, closes))
        results.extend(self._detect_wedges(pivot_highs, pivot_lows, closes))
        results.extend(self._detect_rectangles(pivot_highs, pivot_lows, closes))
        results.extend(self._detect_harmonics(pivot_highs, pivot_lows, closes))
        results.extend(self._detect_wolfe_waves(pivot_highs, pivot_lows, closes))
        results.extend(self._detect_abc(pivot_highs, pivot_lows, closes))
        results.extend(self._detect_ew_4th_wave(pivot_highs, pivot_lows, closes))

        return results

    # ── Pivot Detection ──────────────────────────────────────
    def _find_pivots(self, data: np.ndarray, is_high: bool) -> list[PivotPoint]:
        """Identify local maxima (pivot highs) or minima (pivot lows)."""
        pivots = []
        lb = self.pivot_lookback
        for i in range(lb, len(data) - lb):
            if is_high:
                if data[i] == max(data[i - lb: i + lb + 1]):
                    pivots.append(PivotPoint(index=i, price=data[i], time=None, is_high=True))
            else:
                if data[i] == min(data[i - lb: i + lb + 1]):
                    pivots.append(PivotPoint(index=i, price=data[i], time=None, is_high=False))
        return pivots

    def _prices_near(self, p1: float, p2: float) -> bool:
        """Check if two prices are within tolerance."""
        return abs(p1 - p2) / max(p1, p2) < self.tolerance

    # ── Double Top ───────────────────────────────────────────
    def _detect_double_tops(self, pivot_highs: list[PivotPoint], closes: np.ndarray) -> list[DetectedPatternResult]:
        results = []
        for i in range(len(pivot_highs) - 1):
            p1, p2 = pivot_highs[i], pivot_highs[i + 1]
            if p2.index - p1.index < 10:
                continue
            if self._prices_near(p1.price, p2.price):
                # Neckline = lowest low between the two peaks
                neckline = min(closes[p1.index: p2.index + 1])
                height = p1.price - neckline
                current_close = closes[-1]
                status = "completed" if current_close < neckline else "forming"
                results.append(DetectedPatternResult(
                    pattern_type=PatternType.DOUBLE_TOP,
                    confidence=min(0.95, 0.7 + 0.05 * (p2.index - p1.index) / 20),
                    pivots=[p1, p2],
                    target_price=neckline - height,
                    stop_loss=max(p1.price, p2.price) * 1.01,
                    status=status,
                ))
        return results

    # ── Double Bottom ────────────────────────────────────────
    def _detect_double_bottoms(self, pivot_lows: list[PivotPoint], closes: np.ndarray) -> list[DetectedPatternResult]:
        results = []
        for i in range(len(pivot_lows) - 1):
            p1, p2 = pivot_lows[i], pivot_lows[i + 1]
            if p2.index - p1.index < 10:
                continue
            if self._prices_near(p1.price, p2.price):
                neckline = max(closes[p1.index: p2.index + 1])
                height = neckline - p1.price
                current_close = closes[-1]
                status = "completed" if current_close > neckline else "forming"
                results.append(DetectedPatternResult(
                    pattern_type=PatternType.DOUBLE_BOTTOM,
                    confidence=min(0.95, 0.7 + 0.05 * (p2.index - p1.index) / 20),
                    pivots=[p1, p2],
                    target_price=neckline + height,
                    stop_loss=min(p1.price, p2.price) * 0.99,
                    status=status,
                ))
        return results

    # ── Triple Top/Bottom ────────────────────────────────────
    def _detect_triple_tops(self, pivot_highs: list[PivotPoint], closes: np.ndarray) -> list[DetectedPatternResult]:
        results = []
        for i in range(len(pivot_highs) - 2):
            p1, p2, p3 = pivot_highs[i], pivot_highs[i + 1], pivot_highs[i + 2]
            if self._prices_near(p1.price, p2.price) and self._prices_near(p2.price, p3.price):
                neckline = min(closes[p1.index: p3.index + 1])
                height = p1.price - neckline
                results.append(DetectedPatternResult(
                    pattern_type=PatternType.TRIPLE_TOP,
                    confidence=0.85,
                    pivots=[p1, p2, p3],
                    target_price=neckline - height,
                    stop_loss=max(p1.price, p2.price, p3.price) * 1.01,
                ))
        return results

    def _detect_triple_bottoms(self, pivot_lows: list[PivotPoint], closes: np.ndarray) -> list[DetectedPatternResult]:
        results = []
        for i in range(len(pivot_lows) - 2):
            p1, p2, p3 = pivot_lows[i], pivot_lows[i + 1], pivot_lows[i + 2]
            if self._prices_near(p1.price, p2.price) and self._prices_near(p2.price, p3.price):
                neckline = max(closes[p1.index: p3.index + 1])
                height = neckline - p1.price
                results.append(DetectedPatternResult(
                    pattern_type=PatternType.TRIPLE_BOTTOM,
                    confidence=0.85,
                    pivots=[p1, p2, p3],
                    target_price=neckline + height,
                    stop_loss=min(p1.price, p2.price, p3.price) * 0.99,
                ))
        return results

    # ── Head & Shoulders ─────────────────────────────────────
    def _detect_head_shoulders(
        self, pivot_highs: list[PivotPoint], pivot_lows: list[PivotPoint], closes: np.ndarray
    ) -> list[DetectedPatternResult]:
        results = []
        for i in range(len(pivot_highs) - 2):
            ls, head, rs = pivot_highs[i], pivot_highs[i + 1], pivot_highs[i + 2]
            # Head must be higher than both shoulders
            if head.price > ls.price and head.price > rs.price:
                # Shoulders roughly at same level
                if self._prices_near(ls.price, rs.price):
                    # Find neckline from troughs between shoulders
                    neckline_lows = [p for p in pivot_lows if ls.index < p.index < rs.index]
                    if len(neckline_lows) >= 1:
                        neckline = np.mean([p.price for p in neckline_lows])
                        height = head.price - neckline
                        results.append(DetectedPatternResult(
                            pattern_type=PatternType.HEAD_SHOULDERS,
                            confidence=0.80,
                            pivots=[ls, head, rs],
                            target_price=neckline - height,
                            stop_loss=head.price * 1.01,
                        ))
        return results

    # ── Triangles (min 4 points before breakout) ─────────────
    def _detect_triangles(
        self, pivot_highs: list[PivotPoint], pivot_lows: list[PivotPoint], closes: np.ndarray
    ) -> list[DetectedPatternResult]:
        results = []
        if len(pivot_highs) < 2 or len(pivot_lows) < 2:
            return results

        # Check last 4+ alternating pivots
        recent_highs = pivot_highs[-3:]
        recent_lows = pivot_lows[-3:]

        # Ascending triangle: flat top, rising lows
        if len(recent_highs) >= 2 and len(recent_lows) >= 2:
            flat_top = self._prices_near(recent_highs[-1].price, recent_highs[-2].price)
            rising_lows = recent_lows[-1].price > recent_lows[-2].price

            if flat_top and rising_lows:
                results.append(DetectedPatternResult(
                    pattern_type=PatternType.ASC_TRIANGLE,
                    confidence=0.75,
                    pivots=recent_highs + recent_lows,
                    target_price=recent_highs[-1].price + (recent_highs[-1].price - recent_lows[-1].price),
                ))

            # Descending triangle: flat bottom, falling highs
            flat_bottom = self._prices_near(recent_lows[-1].price, recent_lows[-2].price)
            falling_highs = recent_highs[-1].price < recent_highs[-2].price

            if flat_bottom and falling_highs:
                results.append(DetectedPatternResult(
                    pattern_type=PatternType.DESC_TRIANGLE,
                    confidence=0.75,
                    pivots=recent_highs + recent_lows,
                    target_price=recent_lows[-1].price - (recent_highs[-1].price - recent_lows[-1].price),
                ))

            # Symmetrical triangle: converging highs and lows
            if falling_highs and rising_lows:
                results.append(DetectedPatternResult(
                    pattern_type=PatternType.SYM_TRIANGLE,
                    confidence=0.70,
                    pivots=recent_highs + recent_lows,
                ))

        return results

    # ── Wedges ───────────────────────────────────────────────
    def _detect_wedges(
        self, pivot_highs: list[PivotPoint], pivot_lows: list[PivotPoint], closes: np.ndarray
    ) -> list[DetectedPatternResult]:
        results = []
        if len(pivot_highs) < 2 or len(pivot_lows) < 2:
            return results

        h = pivot_highs[-2:]
        l = pivot_lows[-2:]

        high_slope = (h[-1].price - h[-2].price) / max(1, h[-1].index - h[-2].index)
        low_slope = (l[-1].price - l[-2].price) / max(1, l[-1].index - l[-2].index)

        # Rising wedge: both slopes positive, converging
        if high_slope > 0 and low_slope > 0 and high_slope < low_slope:
            results.append(DetectedPatternResult(
                pattern_type=PatternType.RISING_WEDGE,
                confidence=0.72,
                pivots=h + l,
            ))
        # Falling wedge: both slopes negative, converging
        elif high_slope < 0 and low_slope < 0 and high_slope > low_slope:
            results.append(DetectedPatternResult(
                pattern_type=PatternType.FALLING_WEDGE,
                confidence=0.72,
                pivots=h + l,
            ))

        return results

    # ── Rectangles (min 6 points) ────────────────────────────
    def _detect_rectangles(
        self, pivot_highs: list[PivotPoint], pivot_lows: list[PivotPoint], closes: np.ndarray
    ) -> list[DetectedPatternResult]:
        results = []
        if len(pivot_highs) < 3 or len(pivot_lows) < 3:
            return results

        h = pivot_highs[-3:]
        l = pivot_lows[-3:]

        # All highs near each other and all lows near each other
        high_vals = [p.price for p in h]
        low_vals = [p.price for p in l]

        if (max(high_vals) - min(high_vals)) / max(high_vals) < self.tolerance and \
           (max(low_vals) - min(low_vals)) / max(low_vals) < self.tolerance:
            height = np.mean(high_vals) - np.mean(low_vals)
            results.append(DetectedPatternResult(
                pattern_type=PatternType.RECTANGLE,
                confidence=0.78,
                pivots=h + l,
                target_price=np.mean(high_vals) + height,  # bullish breakout target
            ))

        return results

    # ── Harmonics ────────────────────────────────────────────
    def _detect_harmonics(self, pivot_highs: list[PivotPoint], pivot_lows: list[PivotPoint], closes: np.ndarray) -> list[DetectedPatternResult]:
        results = []
        if len(pivot_highs) < 3 or len(pivot_lows) < 3:
            return results
        
        all_pivots = sorted(pivot_highs[-3:] + pivot_lows[-3:], key=lambda p: p.index)
        if len(all_pivots) < 5:
            return results
            
        pivots = all_pivots[-5:]
        for i in range(1, 5):
            if pivots[i].is_high == pivots[i-1].is_high:
                return results
                
        xa = abs(pivots[1].price - pivots[0].price)
        ab = abs(pivots[2].price - pivots[1].price)
        bc = abs(pivots[3].price - pivots[2].price)
        cd = abs(pivots[4].price - pivots[3].price)
        
        if xa == 0 or ab == 0 or bc == 0:
            return results
            
        ab_xa = ab / xa
        bc_ab = bc / ab
        cd_bc = cd / bc
        
        if 0.3 < ab_xa < 0.9 and 0.3 < bc_ab < 0.9 and 1.1 < cd_bc < 2.6:
            results.append(DetectedPatternResult(
                pattern_type=PatternType.HARMONIC,
                confidence=0.75,
                pivots=pivots,
            ))
            
        return results

    # ── Wolfe Waves ──────────────────────────────────────────
    def _detect_wolfe_waves(self, pivot_highs: list[PivotPoint], pivot_lows: list[PivotPoint], closes: np.ndarray) -> list[DetectedPatternResult]:
        results = []
        # Bullish Wolfe Wave
        if len(pivot_lows) >= 3 and len(pivot_highs) >= 2:
            l1, l3, l5 = pivot_lows[-3], pivot_lows[-2], pivot_lows[-1]
            h2, h4 = pivot_highs[-2], pivot_highs[-1]
            if l1.index < h2.index < l3.index < h4.index < l5.index:
                if l3.price < l1.price and l5.price < l3.price and h4.price < h2.price:
                    if h4.price > l1.price:
                        results.append(DetectedPatternResult(
                            pattern_type=PatternType.WOLFE_WAVE,
                            confidence=0.80,
                            pivots=[l1, h2, l3, h4, l5],
                            target_price=h4.price + (h4.price - l1.price),
                        ))
                            
        # Bearish Wolfe Wave
        if len(pivot_highs) >= 3 and len(pivot_lows) >= 2:
            h1, h3, h5 = pivot_highs[-3], pivot_highs[-2], pivot_highs[-1]
            l2, l4 = pivot_lows[-2], pivot_lows[-1]
            if h1.index < l2.index < h3.index < l4.index < h5.index:
                if h3.price > h1.price and h5.price > h3.price and l4.price > l2.price:
                    if l4.price < h1.price:
                        results.append(DetectedPatternResult(
                            pattern_type=PatternType.WOLFE_WAVE,
                            confidence=0.80,
                            pivots=[h1, l2, h3, l4, h5],
                            target_price=l4.price - (h1.price - l4.price),
                        ))
        return results

    # ── ABC Pattern ──────────────────────────────────────────
    def _detect_abc(self, pivot_highs: list[PivotPoint], pivot_lows: list[PivotPoint], closes: np.ndarray) -> list[DetectedPatternResult]:
        results = []
        if len(pivot_highs) < 2 or len(pivot_lows) < 2:
            return results
            
        all_pivots = sorted(pivot_highs[-2:] + pivot_lows[-2:], key=lambda p: p.index)
        if len(all_pivots) < 3:
            return results
            
        a, b, c = all_pivots[-3], all_pivots[-2], all_pivots[-1]
        ab = abs(b.price - a.price)
        bc = abs(c.price - b.price)
        
        if ab > 0 and 0.382 <= (bc / ab) <= 0.786:
            results.append(DetectedPatternResult(
                pattern_type=PatternType.ABC_PATTERN,
                confidence=0.65,
                pivots=[a, b, c],
            ))
        return results

    # ── EW 4th Wave ──────────────────────────────────────────
    def _detect_ew_4th_wave(self, pivot_highs: list[PivotPoint], pivot_lows: list[PivotPoint], closes: np.ndarray) -> list[DetectedPatternResult]:
        results = []
        if len(pivot_highs) >= 2 and len(pivot_lows) >= 2:
            w1 = pivot_highs[-2]
            w2 = pivot_lows[-2]
            w3 = pivot_highs[-1]
            w4 = pivot_lows[-1]
            
            if w1.index < w2.index < w3.index < w4.index:
                if w3.price > w1.price and w4.price > w1.price and w4.price > w2.price:
                    w3_length = w3.price - w2.price
                    w4_retrace = w3.price - w4.price
                    if w3_length > 0 and 0.2 < (w4_retrace / w3_length) < 0.6:
                        results.append(DetectedPatternResult(
                            pattern_type=PatternType.EW_4TH_WAVE,
                            confidence=0.75,
                            pivots=[w1, w2, w3, w4],
                            target_price=w3.price + w3_length * 0.618,
                        ))
        return results
