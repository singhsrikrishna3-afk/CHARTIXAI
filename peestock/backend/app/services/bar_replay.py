"""PEESTOCK — Bar Replay (Visual Backtesting) Service.

Steps through historical data bar-by-bar, re-computing indicators
at each step to detect repaint behavior.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

import pandas as pd
import numpy as np

from app.services.scanner_engine import (
    compute_sma, compute_ema, compute_rsi, compute_macd,
)


@dataclass
class ReplayFrame:
    """A single frame in the bar replay."""
    bar_index: int
    time: object
    ohlcv: dict
    indicators: dict = field(default_factory=dict)
    signals: list[str] = field(default_factory=list)


@dataclass
class RepaintCheck:
    """Result of a repaint check for a specific indicator."""
    indicator: str
    is_repainting: bool
    repaint_bars: list[int] = field(default_factory=list)
    details: str = ""


class BarReplayEngine:
    """Step through historical data bar-by-bar."""

    def __init__(self, df: pd.DataFrame, indicator_configs: list[dict] = None):
        """
        Args:
            df: Full OHLCV DataFrame.
            indicator_configs: List of indicator configs to compute at each step.
                e.g. [{"name": "sma", "params": {"period": 20}}]
        """
        self.df = df.copy().reset_index(drop=True)
        self.indicator_configs = indicator_configs or [
            {"name": "sma", "params": {"period": 20}},
            {"name": "rsi", "params": {"period": 14}},
        ]
        self._history: list[ReplayFrame] = []

    def replay(self, start: int = 50, end: Optional[int] = None, step: int = 1) -> list[ReplayFrame]:
        """Generate replay frames from start to end bar.

        Args:
            start: First bar index to begin replay (need enough history for indicators).
            end: Last bar index (defaults to end of data).
            step: Number of bars to advance per frame.

        Returns:
            List of ReplayFrame objects.
        """
        if end is None:
            end = len(self.df)

        frames = []
        for i in range(start, end, step):
            slice_df = self.df.iloc[:i + 1].copy()
            bar = self.df.iloc[i]

            indicators = {}
            for cfg in self.indicator_configs:
                name = cfg["name"]
                params = cfg.get("params", {})
                try:
                    if name == "sma":
                        series = compute_sma(slice_df["close"], params.get("period", 20))
                    elif name == "ema":
                        series = compute_ema(slice_df["close"], params.get("period", 20))
                    elif name == "rsi":
                        series = compute_rsi(slice_df["close"], params.get("period", 14))
                    elif name == "macd":
                        result = compute_macd(slice_df["close"])
                        indicators["macd"] = float(result["macd"].iloc[-1]) if not pd.isna(result["macd"].iloc[-1]) else None
                        indicators["macd_signal"] = float(result["signal"].iloc[-1]) if not pd.isna(result["signal"].iloc[-1]) else None
                        continue
                    else:
                        continue

                    val = series.iloc[-1]
                    indicators[name] = float(val) if not pd.isna(val) else None
                except Exception:
                    indicators[name] = None

            frame = ReplayFrame(
                bar_index=i,
                time=bar["time"] if "time" in bar.index else i,
                ohlcv={
                    "open": float(bar["open"]),
                    "high": float(bar["high"]),
                    "low": float(bar["low"]),
                    "close": float(bar["close"]),
                    "volume": int(bar.get("volume", 0)),
                },
                indicators=indicators,
            )
            frames.append(frame)

        self._history = frames
        return frames

    def check_repaint(self) -> list[RepaintCheck]:
        """Check if indicators are repainting by comparing values
        computed at each bar vs. values computed from full dataset.

        Returns:
            List of RepaintCheck results.
        """
        if not self._history:
            return []

        full_indicators = {}
        for cfg in self.indicator_configs:
            name = cfg["name"]
            params = cfg.get("params", {})
            if name == "sma":
                full_indicators[name] = compute_sma(self.df["close"], params.get("period", 20))
            elif name == "ema":
                full_indicators[name] = compute_ema(self.df["close"], params.get("period", 20))
            elif name == "rsi":
                full_indicators[name] = compute_rsi(self.df["close"], params.get("period", 14))

        results = []
        for name, full_series in full_indicators.items():
            repaint_bars = []
            for frame in self._history:
                idx = frame.bar_index
                live_val = frame.indicators.get(name)
                full_val = full_series.iloc[idx] if idx < len(full_series) else None

                if live_val is not None and full_val is not None and not pd.isna(full_val):
                    if abs(live_val - float(full_val)) > 0.01:
                        repaint_bars.append(idx)

            results.append(RepaintCheck(
                indicator=name,
                is_repainting=len(repaint_bars) > 0,
                repaint_bars=repaint_bars,
                details=f"{'Repaints' if repaint_bars else 'Clean'} — {len(repaint_bars)} bars differ",
            ))

        return results
