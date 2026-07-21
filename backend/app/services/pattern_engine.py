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
    # Named sub-scores (0..1) that were blended into `confidence`, e.g.
    # {"price_level_match": 0.82, "volume_confirmation": 1.0}. Lets the UI
    # show *why* a pattern got the score it did instead of a bare percentage.
    confidence_breakdown: dict = field(default_factory=dict)


class PatternEngine:
    """Core pattern detection engine operating on OHLCV DataFrames."""

    def __init__(self, pivot_lookback: int = 5, tolerance: float = 0.02, recency_window: int = 20):
        self.pivot_lookback = pivot_lookback
        self.tolerance = tolerance  # % tolerance for price level matching
        self.recency_window = recency_window  # max bars since last pivot to still count as "current"

    def detect_all(self, df: pd.DataFrame, apply_recency_filter: bool = True) -> list[DetectedPatternResult]:
        """Run all pattern detectors on the given OHLCV DataFrame.

        Args:
            df: DataFrame with columns [time, open, high, low, close, volume]
            apply_recency_filter: when True (live scanning), drop instances
                whose last pivot is older than `recency_window` bars — only
                currently-relevant patterns matter for a live screener. Set
                False for backtesting, where every historical instance is
                wanted. Note only the detectors that loop over the *entire*
                pivot history (double/triple tops & bottoms, head &
                shoulders) actually yield more than one instance per call —
                the tail-only detectors (triangles, wedges, rectangles,
                harmonics, Wolfe waves, ABC, EW4) always look at just the
                last few pivots regardless of this flag.

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
        results.extend(self._detect_double_tops(pivot_highs, closes, volumes))
        results.extend(self._detect_double_bottoms(pivot_lows, closes, volumes))
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

        if apply_recency_filter:
            # Drop stale matches: a pattern whose most recent pivot is from
            # many bars ago is no longer relevant even if price hasn't
            # technically broken its neckline yet — price has likely moved
            # on entirely.
            last_bar = len(df) - 1
            results = [
                r for r in results
                if r.pivots and (last_bar - max(p.index for p in r.pivots)) <= self.recency_window
            ]
        else:
            results = [r for r in results if r.pivots]

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

    def _level_match_score(self, p1: float, p2: float) -> float:
        """0..1 score for how tightly two pivot prices match: 1.0 means
        identical prices, 0.0 means they sit right at the tolerance boundary
        (the loosest match `_prices_near` still accepts)."""
        diff = abs(p1 - p2) / max(p1, p2)
        return max(0.0, 1.0 - diff / self.tolerance)

    def _ratio_fit_score(self, ratio: float, ideal: float, spread: float) -> float:
        """0..1 score for how close `ratio` sits to an `ideal` target value,
        falling to 0 once it's `spread` away — used to grade Fibonacci-style
        ratio patterns (harmonics, ABC, Elliott waves) by how textbook-clean
        the measured ratio actually is, instead of a pass/fail band."""
        return max(0.0, 1.0 - abs(ratio - ideal) / spread)

    def _volume_confirmation_score(self, volumes: Optional[np.ndarray], breakout_idx: int, lookback: int = 20) -> float:
        """0..1 score for breakout-bar volume vs. the preceding average.
        A breakout on average or below-average volume is suspect; this
        rewards the classic 'volume confirms the break' heuristic without
        overstating it for ordinary up-days."""
        if volumes is None or breakout_idx is None or breakout_idx <= 0:
            return 0.0
        start = max(0, breakout_idx - lookback)
        prior = volumes[start:breakout_idx]
        avg_prior = np.mean(prior) if len(prior) else 0.0
        if not avg_prior:
            return 0.0
        ratio = volumes[breakout_idx] / avg_prior
        # 1.0x avg volume -> no credit; 2.0x+ avg volume -> full credit.
        return float(np.clip(ratio - 1.0, 0.0, 1.0))

    # ── Double Top ───────────────────────────────────────────
    def _detect_double_tops(
        self, pivot_highs: list[PivotPoint], closes: np.ndarray, volumes: Optional[np.ndarray] = None
    ) -> list[DetectedPatternResult]:
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

                match_score = self._level_match_score(p1.price, p2.price)
                duration_score = min(1.0, (p2.index - p1.index) / 40)
                vol_score = self._volume_confirmation_score(volumes, len(closes) - 1) if status == "completed" else 0.0
                confidence = 0.55 + 0.20 * match_score + 0.10 * duration_score + 0.10 * vol_score

                results.append(DetectedPatternResult(
                    pattern_type=PatternType.DOUBLE_TOP,
                    confidence=round(min(0.95, confidence), 2),
                    pivots=[p1, p2],
                    target_price=neckline - height,
                    stop_loss=max(p1.price, p2.price) * 1.01,
                    status=status,
                    confidence_breakdown={
                        "price_level_match": round(match_score, 2),
                        "peak_separation": round(duration_score, 2),
                        "breakdown_volume": round(vol_score, 2),
                    },
                ))
        return results

    # ── Double Bottom ────────────────────────────────────────
    def _detect_double_bottoms(
        self, pivot_lows: list[PivotPoint], closes: np.ndarray, volumes: Optional[np.ndarray] = None
    ) -> list[DetectedPatternResult]:
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

                match_score = self._level_match_score(p1.price, p2.price)
                duration_score = min(1.0, (p2.index - p1.index) / 40)
                vol_score = self._volume_confirmation_score(volumes, len(closes) - 1) if status == "completed" else 0.0
                confidence = 0.55 + 0.20 * match_score + 0.10 * duration_score + 0.10 * vol_score

                results.append(DetectedPatternResult(
                    pattern_type=PatternType.DOUBLE_BOTTOM,
                    confidence=round(min(0.95, confidence), 2),
                    pivots=[p1, p2],
                    target_price=neckline + height,
                    stop_loss=min(p1.price, p2.price) * 0.99,
                    status=status,
                    confidence_breakdown={
                        "price_level_match": round(match_score, 2),
                        "trough_separation": round(duration_score, 2),
                        "breakout_volume": round(vol_score, 2),
                    },
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
                match_score = (self._level_match_score(p1.price, p2.price) + self._level_match_score(p2.price, p3.price)) / 2
                confidence = 0.60 + 0.30 * match_score
                results.append(DetectedPatternResult(
                    pattern_type=PatternType.TRIPLE_TOP,
                    confidence=round(min(0.95, confidence), 2),
                    pivots=[p1, p2, p3],
                    target_price=neckline - height,
                    stop_loss=max(p1.price, p2.price, p3.price) * 1.01,
                    confidence_breakdown={"price_level_match": round(match_score, 2)},
                ))
        return results

    def _detect_triple_bottoms(self, pivot_lows: list[PivotPoint], closes: np.ndarray) -> list[DetectedPatternResult]:
        results = []
        for i in range(len(pivot_lows) - 2):
            p1, p2, p3 = pivot_lows[i], pivot_lows[i + 1], pivot_lows[i + 2]
            if self._prices_near(p1.price, p2.price) and self._prices_near(p2.price, p3.price):
                neckline = max(closes[p1.index: p3.index + 1])
                height = neckline - p1.price
                match_score = (self._level_match_score(p1.price, p2.price) + self._level_match_score(p2.price, p3.price)) / 2
                confidence = 0.60 + 0.30 * match_score
                results.append(DetectedPatternResult(
                    pattern_type=PatternType.TRIPLE_BOTTOM,
                    confidence=round(min(0.95, confidence), 2),
                    pivots=[p1, p2, p3],
                    target_price=neckline + height,
                    stop_loss=min(p1.price, p2.price, p3.price) * 0.99,
                    confidence_breakdown={"price_level_match": round(match_score, 2)},
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
                        shoulder_match = self._level_match_score(ls.price, rs.price)
                        # How clearly the head stands above the shoulders, relative
                        # to the pattern's own height — a barely-higher head is a
                        # weak (likely noisy) H&S, not a textbook one.
                        prominence = (head.price - max(ls.price, rs.price)) / height if height > 0 else 0.0
                        prominence_score = float(np.clip(prominence / 0.15, 0.0, 1.0))
                        confidence = 0.55 + 0.20 * shoulder_match + 0.15 * prominence_score
                        results.append(DetectedPatternResult(
                            pattern_type=PatternType.HEAD_SHOULDERS,
                            confidence=round(min(0.95, confidence), 2),
                            pivots=[ls, head, rs],
                            target_price=neckline - height,
                            stop_loss=head.price * 1.01,
                            confidence_breakdown={
                                "shoulder_symmetry": round(shoulder_match, 2),
                                "head_prominence": round(prominence_score, 2),
                            },
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
                flat_score = self._level_match_score(recent_highs[-1].price, recent_highs[-2].price)
                rise_pct = (recent_lows[-1].price - recent_lows[-2].price) / recent_lows[-2].price
                rise_score = float(np.clip(rise_pct / 0.05, 0.0, 1.0))
                confidence = 0.50 + 0.25 * flat_score + 0.15 * rise_score
                results.append(DetectedPatternResult(
                    pattern_type=PatternType.ASC_TRIANGLE,
                    confidence=round(min(0.90, confidence), 2),
                    pivots=recent_highs + recent_lows,
                    target_price=recent_highs[-1].price + (recent_highs[-1].price - recent_lows[-1].price),
                    confidence_breakdown={
                        "resistance_flatness": round(flat_score, 2),
                        "support_rise": round(rise_score, 2),
                    },
                ))

            # Descending triangle: flat bottom, falling highs
            flat_bottom = self._prices_near(recent_lows[-1].price, recent_lows[-2].price)
            falling_highs = recent_highs[-1].price < recent_highs[-2].price

            if flat_bottom and falling_highs:
                flat_score = self._level_match_score(recent_lows[-1].price, recent_lows[-2].price)
                fall_pct = (recent_highs[-2].price - recent_highs[-1].price) / recent_highs[-2].price
                fall_score = float(np.clip(fall_pct / 0.05, 0.0, 1.0))
                confidence = 0.50 + 0.25 * flat_score + 0.15 * fall_score
                results.append(DetectedPatternResult(
                    pattern_type=PatternType.DESC_TRIANGLE,
                    confidence=round(min(0.90, confidence), 2),
                    pivots=recent_highs + recent_lows,
                    target_price=recent_lows[-1].price - (recent_highs[-1].price - recent_lows[-1].price),
                    confidence_breakdown={
                        "support_flatness": round(flat_score, 2),
                        "resistance_fall": round(fall_score, 2),
                    },
                ))

            # Symmetrical triangle: converging highs and lows
            if falling_highs and rising_lows:
                width_first = recent_highs[-2].price - recent_lows[-2].price
                width_last = recent_highs[-1].price - recent_lows[-1].price
                convergence = (width_first - width_last) / width_first if width_first > 0 else 0.0
                convergence_score = float(np.clip(convergence, 0.0, 1.0))
                confidence = 0.50 + 0.30 * convergence_score
                results.append(DetectedPatternResult(
                    pattern_type=PatternType.SYM_TRIANGLE,
                    confidence=round(min(0.85, confidence), 2),
                    pivots=recent_highs + recent_lows,
                    confidence_breakdown={"range_convergence": round(convergence_score, 2)},
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

        width_first = h[-2].price - l[-2].price
        width_last = h[-1].price - l[-1].price
        convergence = (width_first - width_last) / width_first if width_first > 0 else 0.0
        convergence_score = float(np.clip(convergence, 0.0, 1.0))
        # Wedges are a lower-reliability pattern than triangles/H&S even when
        # textbook-clean, so the base prior and cap both sit lower.
        confidence = round(min(0.80, 0.45 + 0.30 * convergence_score), 2)

        # Rising wedge: both slopes positive, converging
        breakdown = {"range_convergence": round(convergence_score, 2)}
        if high_slope > 0 and low_slope > 0 and high_slope < low_slope:
            results.append(DetectedPatternResult(
                pattern_type=PatternType.RISING_WEDGE,
                confidence=confidence,
                pivots=h + l,
                confidence_breakdown=breakdown,
            ))
        # Falling wedge: both slopes negative, converging
        elif high_slope < 0 and low_slope < 0 and high_slope > low_slope:
            results.append(DetectedPatternResult(
                pattern_type=PatternType.FALLING_WEDGE,
                confidence=confidence,
                pivots=h + l,
                confidence_breakdown=breakdown,
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

        high_spread = (max(high_vals) - min(high_vals)) / max(high_vals)
        low_spread = (max(low_vals) - min(low_vals)) / max(low_vals)
        if high_spread < self.tolerance and low_spread < self.tolerance:
            height = np.mean(high_vals) - np.mean(low_vals)
            tightness_score = float(np.clip(1.0 - (high_spread + low_spread) / (2 * self.tolerance), 0.0, 1.0))
            confidence = 0.55 + 0.30 * tightness_score
            results.append(DetectedPatternResult(
                pattern_type=PatternType.RECTANGLE,
                confidence=round(min(0.90, confidence), 2),
                pivots=h + l,
                target_price=np.mean(high_vals) + height,  # bullish breakout target
                confidence_breakdown={"channel_tightness": round(tightness_score, 2)},
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
            # Score against the classic harmonic anchor ratios (Gartley-style
            # AB=0.618*XA, BC=0.618-0.886*AB, CD=1.272-1.618*BC) rather than
            # just the looser pass/fail band above — a ratio set sitting
            # right on the textbook numbers is a stronger harmonic than one
            # that merely squeaks inside the band.
            ab_score = self._ratio_fit_score(ab_xa, 0.618, 0.3)
            bc_score = self._ratio_fit_score(bc_ab, 0.618, 0.3)
            cd_score = self._ratio_fit_score(cd_bc, 1.618, 0.75)
            fit_score = (ab_score + bc_score + cd_score) / 3
            confidence = 0.50 + 0.35 * fit_score
            results.append(DetectedPatternResult(
                pattern_type=PatternType.HARMONIC,
                confidence=round(min(0.90, confidence), 2),
                pivots=pivots,
                confidence_breakdown={
                    "ab_xa_fib_fit": round(ab_score, 2),
                    "bc_ab_fib_fit": round(bc_score, 2),
                    "cd_bc_fib_fit": round(cd_score, 2),
                },
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
                        # A textbook Wolfe wave has roughly parallel, evenly-timed
                        # legs (1-3 and 3-5 channel lines); score how closely this
                        # one matches that rather than treating any valid zigzag
                        # shape as equally reliable.
                        amp1, amp2 = h2.price - l1.price, h4.price - l3.price
                        amp_score = 1 - abs(amp1 - amp2) / max(amp1, amp2) if max(amp1, amp2) > 0 else 0.0
                        t1, t2 = h2.index - l1.index, h4.index - l3.index
                        time_score = 1 - abs(t1 - t2) / max(t1, t2) if max(t1, t2) > 0 else 0.0
                        confidence = 0.55 + 0.20 * max(0.0, amp_score) + 0.10 * max(0.0, time_score)
                        results.append(DetectedPatternResult(
                            pattern_type=PatternType.WOLFE_WAVE,
                            confidence=round(min(0.90, confidence), 2),
                            pivots=[l1, h2, l3, h4, l5],
                            target_price=h4.price + (h4.price - l1.price),
                            confidence_breakdown={
                                "leg_amplitude_symmetry": round(max(0.0, amp_score), 2),
                                "leg_timing_symmetry": round(max(0.0, time_score), 2),
                            },
                        ))
                            
        # Bearish Wolfe Wave
        if len(pivot_highs) >= 3 and len(pivot_lows) >= 2:
            h1, h3, h5 = pivot_highs[-3], pivot_highs[-2], pivot_highs[-1]
            l2, l4 = pivot_lows[-2], pivot_lows[-1]
            if h1.index < l2.index < h3.index < l4.index < h5.index:
                if h3.price > h1.price and h5.price > h3.price and l4.price > l2.price:
                    if l4.price < h1.price:
                        amp1, amp2 = h1.price - l2.price, h3.price - l4.price
                        amp_score = 1 - abs(amp1 - amp2) / max(amp1, amp2) if max(amp1, amp2) > 0 else 0.0
                        t1, t2 = l2.index - h1.index, l4.index - h3.index
                        time_score = 1 - abs(t1 - t2) / max(t1, t2) if max(t1, t2) > 0 else 0.0
                        confidence = 0.55 + 0.20 * max(0.0, amp_score) + 0.10 * max(0.0, time_score)
                        results.append(DetectedPatternResult(
                            pattern_type=PatternType.WOLFE_WAVE,
                            confidence=round(min(0.90, confidence), 2),
                            pivots=[h1, l2, h3, l4, h5],
                            target_price=l4.price - (h1.price - l4.price),
                            confidence_breakdown={
                                "leg_amplitude_symmetry": round(max(0.0, amp_score), 2),
                                "leg_timing_symmetry": round(max(0.0, time_score), 2),
                            },
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
            # 0.618 is the canonical AB=CD retracement anchor for an ABC
            # correction; grade how close this one sits to it rather than
            # treating the whole [0.382, 0.786] band as uniformly valid.
            fit_score = self._ratio_fit_score(bc / ab, 0.618, 0.2)
            confidence = 0.45 + 0.30 * fit_score
            results.append(DetectedPatternResult(
                pattern_type=PatternType.ABC_PATTERN,
                confidence=round(min(0.80, confidence), 2),
                pivots=[a, b, c],
                confidence_breakdown={"bc_ab_fib_fit": round(fit_score, 2)},
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
                        # Elliott theory's sweet spot for a 4th-wave retrace is
                        # the 0.382 Fibonacci level; score distance from that
                        # rather than treating the whole [0.2, 0.6] pass band
                        # as equally textbook.
                        fit_score = self._ratio_fit_score(w4_retrace / w3_length, 0.382, 0.2)
                        confidence = 0.50 + 0.30 * fit_score
                        results.append(DetectedPatternResult(
                            pattern_type=PatternType.EW_4TH_WAVE,
                            confidence=round(min(0.85, confidence), 2),
                            pivots=[w1, w2, w3, w4],
                            target_price=w3.price + w3_length * 0.618,
                            confidence_breakdown={"wave4_retrace_fib_fit": round(fit_score, 2)},
                        ))
        return results
