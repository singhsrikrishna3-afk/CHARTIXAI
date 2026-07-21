"""PEESTOCK — SQLAlchemy ORM models."""

from __future__ import annotations

import uuid
from datetime import date, datetime

from sqlalchemy import (
    Boolean, Column, Date, DateTime, Enum, ForeignKey, Index,
    Integer, Numeric, String, Text, BigInteger, func,
)
from sqlalchemy import JSON
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship

from app.database import Base


# ── Instruments ──────────────────────────────────────────────
class Instrument(Base):
    __tablename__ = "instruments"

    id = Column(Integer, primary_key=True, autoincrement=True)
    symbol = Column(String(20), unique=True, nullable=False, index=True)
    name = Column(String(200), nullable=False)
    exchange = Column(String(10), default="NSE")
    segment = Column(String(20), default="EQ")
    isin = Column(String(12))
    lot_size = Column(Integer, default=1)
    is_active = Column(Boolean, default=True)
    is_intraday = Column(Boolean, default=False)
    sector = Column(String(100))
    industry = Column(String(100))
    created_at = Column(DateTime(timezone=True), default=datetime.utcnow)


# ── Index Constituents ──────────────────────────────────────────
class IndexConstituent(Base):
    __tablename__ = "index_constituents"

    index_id = Column(Integer, ForeignKey("instruments.id", ondelete="CASCADE"), primary_key=True)
    instrument_id = Column(Integer, ForeignKey("instruments.id", ondelete="CASCADE"), primary_key=True)

    __table_args__ = (
        Index("idx_idx_const_index", "index_id"),
        Index("idx_idx_const_instr", "instrument_id"),
    )


# ── OHLCV EOD ───────────────────────────────────────────────

class OhlcvEod(Base):
    __tablename__ = "ohlcv_eod"

    time = Column(Date, primary_key=True)
    instrument_id = Column(Integer, ForeignKey("instruments.id"), primary_key=True)
    open = Column(Numeric(12, 2))
    high = Column(Numeric(12, 2))
    low = Column(Numeric(12, 2))
    close = Column(Numeric(12, 2))
    volume = Column(BigInteger)
    delivery_qty = Column(BigInteger)
    delivery_per = Column(Numeric(5, 2))   # NSE DELIV_PER — % of traded qty actually delivered

    __table_args__ = (
        Index("idx_ohlcv_eod_instr_time", "instrument_id", "time"),
    )


# ── OHLCV Intraday ──────────────────────────────────────────
class OhlcvIntraday(Base):
    __tablename__ = "ohlcv_intraday"

    time = Column(DateTime(timezone=True), primary_key=True)
    instrument_id = Column(Integer, ForeignKey("instruments.id"), primary_key=True)
    open = Column(Numeric(12, 2))
    high = Column(Numeric(12, 2))
    low = Column(Numeric(12, 2))
    close = Column(Numeric(12, 2))
    volume = Column(BigInteger)

    __table_args__ = (
        Index("idx_ohlcv_intra_instr_time", "instrument_id", "time"),
    )


# ── OHLCV Resampled ─────────────────────────────────────────
class OhlcvResampled(Base):
    __tablename__ = "ohlcv_resampled"

    time = Column(DateTime(timezone=True), primary_key=True)
    instrument_id = Column(Integer, ForeignKey("instruments.id"), primary_key=True)
    timeframe = Column(String(5), primary_key=True)
    open = Column(Numeric(12, 2))
    high = Column(Numeric(12, 2))
    low = Column(Numeric(12, 2))
    close = Column(Numeric(12, 2))
    volume = Column(BigInteger)

    __table_args__ = (
        Index("idx_ohlcv_resamp_instr_time", "instrument_id", "time"),
    )


# ── Users ────────────────────────────────────────────────────
class User(Base):
    __tablename__ = "users"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    email = Column(String(255), unique=True, nullable=False, index=True)
    password_hash = Column(String(255), nullable=False)
    full_name = Column(String(100))
    phone = Column(String(15))
    is_active = Column(Boolean, default=True)
    is_admin = Column(Boolean, default=False)
    created_at = Column(DateTime(timezone=True), default=datetime.utcnow)
    updated_at = Column(DateTime(timezone=True), default=datetime.utcnow, onupdate=datetime.utcnow)

    subscriptions = relationship("Subscription", back_populates="user")
    scanners = relationship("CustomScanner", back_populates="user")


# ── Subscriptions ────────────────────────────────────────────
class Subscription(Base):
    __tablename__ = "subscriptions"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    tier = Column(String(20), nullable=False, default="free")
    status = Column(String(20), nullable=False, default="trial")
    starts_at = Column(DateTime(timezone=True), default=datetime.utcnow)
    expires_at = Column(DateTime(timezone=True))
    razorpay_sub_id = Column(String(100))
    created_at = Column(DateTime(timezone=True), default=datetime.utcnow)

    user = relationship("User", back_populates="subscriptions")


# ── Detected Patterns ───────────────────────────────────────
class DetectedPattern(Base):
    __tablename__ = "detected_patterns"

    id = Column(Integer, primary_key=True, autoincrement=True)
    instrument_id = Column(Integer, ForeignKey("instruments.id"), nullable=False)
    timeframe = Column(String(5), nullable=False)
    pattern_type = Column(String(50), nullable=False)
    status = Column(String(20), default="forming")
    confidence = Column(Numeric(5, 2))
    detection_time = Column(DateTime(timezone=True), default=datetime.utcnow)
    key_points = Column(JSON)
    target_price = Column(Numeric(12, 2))
    stop_loss = Column(Numeric(12, 2))
    image_url = Column(Text)
    created_at = Column(DateTime(timezone=True), default=datetime.utcnow)

    __table_args__ = (
        Index("idx_pat_instr", "instrument_id", "detection_time"),
        Index("idx_pat_type", "pattern_type", "status"),
    )


# ── Pattern Backtest Stats ───────────────────────────────────
class PatternBacktestStat(Base):
    """Empirical win-rate for a (pattern_type, fit_tier) bucket, computed by
    walking forward from every historical detection of that pattern type
    across all instruments and checking whether target_price or stop_loss
    was touched first. `fit_tier` buckets instances by their geometric-fit
    score (low/med/high) so a clean vs. sloppy instance of the same pattern
    type can carry a different empirical confidence."""

    __tablename__ = "pattern_backtest_stats"

    id = Column(Integer, primary_key=True, autoincrement=True)
    pattern_type = Column(String(50), nullable=False)
    fit_tier = Column(String(10), nullable=False)  # "low" | "med" | "high"
    wins = Column(Integer, nullable=False, default=0)
    losses = Column(Integer, nullable=False, default=0)
    win_rate = Column(Numeric(5, 4))
    sample_size = Column(Integer, nullable=False, default=0)
    updated_at = Column(DateTime(timezone=True), default=datetime.utcnow)

    __table_args__ = (
        Index("idx_backtest_pattern_tier", "pattern_type", "fit_tier", unique=True),
    )


# ── Custom Scanners ─────────────────────────────────────────
class CustomScanner(Base):
    __tablename__ = "custom_scanners"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    name = Column(String(100), nullable=False)
    description = Column(Text)
    conditions = Column(JSON, nullable=False)
    logic = Column(String(10), default="AND", nullable=False)
    is_public = Column(Boolean, default=False)
    created_at = Column(DateTime(timezone=True), default=datetime.utcnow)
    updated_at = Column(DateTime(timezone=True), default=datetime.utcnow, onupdate=datetime.utcnow)

    user = relationship("User", back_populates="scanners")


# ── Trendlines ───────────────────────────────────────────────
class Trendline(Base):
    __tablename__ = "trendlines"

    id = Column(Integer, primary_key=True, autoincrement=True)
    instrument_id = Column(Integer, ForeignKey("instruments.id"), nullable=False)
    timeframe = Column(String(5), nullable=False)
    line_type = Column(String(20))
    slope = Column(Numeric(10, 6))
    intercept = Column(Numeric(12, 2))
    point_a_time = Column(DateTime(timezone=True))
    point_a_price = Column(Numeric(12, 2))
    point_b_time = Column(DateTime(timezone=True))
    point_b_price = Column(Numeric(12, 2))
    touches = Column(Integer, default=2)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime(timezone=True), default=datetime.utcnow)

    __table_args__ = (
        Index("idx_tl_instr", "instrument_id", "is_active"),
    )


# ── Watchlist ────────────────────────────────────────────────
class WatchlistItem(Base):
    __tablename__ = "watchlist_items"

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    instrument_id = Column(Integer, ForeignKey("instruments.id"), nullable=False)
    added_at = Column(DateTime(timezone=True), default=datetime.utcnow)

    __table_args__ = (
        Index("idx_watchlist_user", "user_id", "instrument_id", unique=True),
    )


# ── Portfolio ────────────────────────────────────────────────
class PortfolioPosition(Base):
    __tablename__ = "portfolio_positions"

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    instrument_id = Column(Integer, ForeignKey("instruments.id"), nullable=False)
    quantity = Column(Numeric(14, 4), nullable=False)
    buy_price = Column(Numeric(12, 2), nullable=False)
    buy_date = Column(Date, nullable=False)
    notes = Column(Text)
    created_at = Column(DateTime(timezone=True), default=datetime.utcnow)
    updated_at = Column(DateTime(timezone=True), default=datetime.utcnow, onupdate=datetime.utcnow)

    __table_args__ = (
        Index("idx_portfolio_user", "user_id"),
    )


# ── Alerts ───────────────────────────────────────────────────
class AlertRule(Base):
    __tablename__ = "alert_rules"

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    instrument_id = Column(Integer, ForeignKey("instruments.id"), nullable=True)  # null = any symbol
    alert_type = Column(String(20), nullable=False)  # 'price_above', 'price_below', 'pattern'
    target_price = Column(Numeric(12, 2))
    pattern_type = Column(String(50))  # null = any pattern type
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime(timezone=True), default=datetime.utcnow)

    __table_args__ = (
        Index("idx_alert_rules_user", "user_id", "is_active"),
    )


class TriggeredAlert(Base):
    __tablename__ = "triggered_alerts"

    id = Column(Integer, primary_key=True, autoincrement=True)
    alert_rule_id = Column(Integer, ForeignKey("alert_rules.id", ondelete="CASCADE"), nullable=False)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    instrument_id = Column(Integer, ForeignKey("instruments.id"), nullable=False)
    pattern_type = Column(String(50))  # set for pattern alerts; used for cooldown dedup
    message = Column(Text, nullable=False)
    triggered_at = Column(DateTime(timezone=True), default=datetime.utcnow)
    is_read = Column(Boolean, default=False)

    __table_args__ = (
        Index("idx_triggered_alerts_user", "user_id", "is_read", "triggered_at"),
    )


# ── Forecasts ────────────────────────────────────────────────
class Forecast(Base):
    __tablename__ = "forecasts"

    id = Column(Integer, primary_key=True, autoincrement=True)
    instrument_id = Column(Integer, ForeignKey("instruments.id"), nullable=False, index=True)
    as_of_date = Column(Date, nullable=False, index=True)
    horizon_day = Column(Integer, nullable=False)  # 1..10
    predicted_close = Column(Numeric(12, 2), nullable=False)
    lower_band = Column(Numeric(12, 2), nullable=False)
    upper_band = Column(Numeric(12, 2), nullable=False)
    model_version = Column(String(40), nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        Index("idx_forecasts_instr_asof", "instrument_id", "as_of_date"),
    )


# ── NSE Trading Holidays ─────────────────────────────────────
class NseHoliday(Base):
    __tablename__ = "nse_holidays"

    id = Column(Integer, primary_key=True, autoincrement=True)
    trading_date = Column(Date, nullable=False, unique=True, index=True)
    week_day = Column(String(15), nullable=False)
    description = Column(String(200), nullable=False)
    holiday_type = Column(String(50), default="trading")


# ── Fundamentals (latest snapshot per instrument) ────────────
class Fundamentals(Base):
    """One row per instrument holding the latest fundamental snapshot.
    Percent-style fields (roe, dividend_yield, promoter_holding, growths,
    profit_margin) are stored as percentages (9.14 = 9.14%); debt_to_equity is a
    plain ratio (0.37 = 0.37x). Source-agnostic: currently filled from Yahoo
    Finance, swappable for a licensed feed later."""
    __tablename__ = "fundamentals"

    instrument_id = Column(Integer, ForeignKey("instruments.id", ondelete="CASCADE"), primary_key=True)
    market_cap = Column(BigInteger)            # INR
    pe = Column(Numeric(14, 2))                # trailing P/E
    forward_pe = Column(Numeric(14, 2))
    pb = Column(Numeric(14, 2))                # price / book
    roe = Column(Numeric(10, 2))               # %
    debt_to_equity = Column(Numeric(12, 2))    # ratio (x)
    dividend_yield = Column(Numeric(10, 2))    # %
    eps = Column(Numeric(14, 2))               # trailing EPS
    revenue_growth = Column(Numeric(10, 2))    # % YoY
    earnings_growth = Column(Numeric(10, 2))   # % YoY
    profit_margin = Column(Numeric(10, 2))     # %
    book_value = Column(Numeric(14, 2))
    week52_high = Column(Numeric(14, 2))
    week52_low = Column(Numeric(14, 2))
    promoter_holding = Column(Numeric(10, 2))  # % held by insiders/promoters
    sector_src = Column(String(80))            # sector per data source
    industry_src = Column(String(120))
    updated_at = Column(DateTime(timezone=True), default=datetime.utcnow, onupdate=datetime.utcnow)


# ── Scan History ─────────────────────────────────────────────
class ScanHistory(Base):
    """A persisted record of every executed scan — the full result set plus the
    parameters and the date/time it ran."""
    __tablename__ = "scan_history"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"),
                     nullable=True, index=True)
    scan_type = Column(String(30), nullable=False, index=True)  # ma|indicator|candlestick|other|scanner|screener
    params = Column(JSON, nullable=False)
    result_count = Column(Integer, nullable=False, default=0)
    matches = Column(JSON, nullable=False, default=list)
    created_at = Column(DateTime(timezone=True), default=datetime.utcnow, index=True)

    __table_args__ = (
        Index("idx_scan_history_user_time", "user_id", "created_at"),
    )


class UserPref(Base):
    """Per-user key→JSON store for chart layout, indicator settings and drawings.
    One row per (user, key). Keys used by the frontend:
      • "chart_layout"      — indicators, params, styles, MA lines, price-scale mode
      • "drawings:<SYMBOL>" — trendlines / support-resistance / annotations per stock
    Only the owning user can read or write their rows."""
    __tablename__ = "user_prefs"

    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"),
                     primary_key=True)
    pref_key = Column(String(120), primary_key=True)
    value = Column(JSON, nullable=False, default=dict)
    updated_at = Column(DateTime(timezone=True), default=datetime.utcnow, onupdate=datetime.utcnow)


class PaperTrade(Base):
    """A simulated swing trade a user opens to test a plan (theirs or one of the
    app's recommendations). Evaluated against real EOD data: hit target/stop,
    current P&L, days held. No real money — a risk-free journal."""
    __tablename__ = "paper_trades"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"),
                     nullable=False, index=True)
    symbol = Column(String(40), nullable=False)
    direction = Column(String(5), nullable=False, default="long")  # long | short
    qty = Column(Integer, nullable=False, default=1)
    entry_price = Column(Numeric(14, 2), nullable=False)
    entry_date = Column(Date, nullable=False, default=date.today)
    stop = Column(Numeric(14, 2))
    target1 = Column(Numeric(14, 2))
    target2 = Column(Numeric(14, 2))
    setup = Column(String(40))          # e.g. "Breakout", "manual"
    source = Column(String(20), default="manual")  # manual | recommendation
    notes = Column(Text)
    status = Column(String(12), nullable=False, default="open")  # open | closed
    exit_price = Column(Numeric(14, 2))
    exit_date = Column(Date)
    exit_reason = Column(String(24))    # target1 | target2 | stop | manual
    created_at = Column(DateTime(timezone=True), default=datetime.utcnow)

