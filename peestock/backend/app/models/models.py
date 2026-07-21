"""PEESTOCK — SQLAlchemy ORM models."""

from __future__ import annotations

import uuid
from datetime import date, datetime

from sqlalchemy import (
    Boolean, Column, Date, DateTime, Enum, ForeignKey, Index,
    Integer, Numeric, String, Text, BigInteger,
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
    created_at = Column(DateTime(timezone=True), default=datetime.utcnow)


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


# ── Users ────────────────────────────────────────────────────
class User(Base):
    __tablename__ = "users"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    email = Column(String(255), unique=True, nullable=False, index=True)
    password_hash = Column(String(255), nullable=False)
    full_name = Column(String(100))
    phone = Column(String(15))
    is_active = Column(Boolean, default=True)
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
