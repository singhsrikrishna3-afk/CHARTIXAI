"""PEESTOCK — Pydantic request/response schemas."""

from __future__ import annotations

from datetime import date, datetime
from typing import Optional, Union
from uuid import UUID

from pydantic import BaseModel, EmailStr, Field, field_validator


# ── Auth ─────────────────────────────────────────────────────
class UserRegister(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8)
    full_name: Optional[str] = None
    phone: Optional[str] = None


class UserLogin(BaseModel):
    email: EmailStr
    password: str


class UserOut(BaseModel):
    id: UUID
    email: str
    full_name: Optional[str]
    is_active: bool
    created_at: datetime

    class Config:
        from_attributes = True


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserOut


# ── Subscription ─────────────────────────────────────────────
class SubscriptionOut(BaseModel):
    id: UUID
    tier: str
    status: str
    starts_at: datetime
    expires_at: datetime

    class Config:
        from_attributes = True


# ── Instrument ───────────────────────────────────────────────
class InstrumentOut(BaseModel):
    id: int
    symbol: str
    name: str
    exchange: Optional[str] = "NSE"
    segment: Optional[str] = "EQ"
    is_intraday: Optional[bool] = False

    class Config:
        from_attributes = True

    @field_validator("exchange", mode="before")
    @classmethod
    def default_exchange(cls, v):
        return "NSE" if v is None else v

    @field_validator("segment", mode="before")
    @classmethod
    def default_segment(cls, v):
        return "EQ" if v is None else v

    @field_validator("is_intraday", mode="before")
    @classmethod
    def default_is_intraday(cls, v):
        return False if v is None else v


# ── OHLCV ────────────────────────────────────────────────────
class OhlcvBar(BaseModel):
    time: Union[datetime, date]
    open: float
    high: float
    low: float
    close: float
    volume: int


# ── Pattern ──────────────────────────────────────────────────
class PatternOut(BaseModel):
    id: int
    symbol: Optional[str] = None
    timeframe: str
    pattern_type: str
    status: str
    confidence: Optional[float]
    detection_time: datetime
    key_points: Optional[dict] = None
    target_price: Optional[float]
    stop_loss: Optional[float]
    image_url: Optional[str]

    class Config:
        from_attributes = True


# ── Custom Scanner ───────────────────────────────────────────
class ScannerCondition(BaseModel):
    """A single condition node in the no-code scanner tree."""
    indicator: str          # 'sma', 'ema', 'rsi', 'macd', 'price', etc.
    params: dict = {}       # e.g. {"period": 20}
    operator: str           # 'gt', 'lt', 'crosses_above', 'crosses_below', 'slope_up'
    value: Optional[float] = None
    compare_to: Optional[dict] = None  # another indicator to compare against


class ScannerCreate(BaseModel):
    name: str
    description: Optional[str] = None
    conditions: list[ScannerCondition]
    logic: str = "AND"  # 'AND' / 'OR'
    is_public: bool = False


class ScannerOut(BaseModel):
    id: UUID
    name: str
    description: Optional[str]
    conditions: list[dict]
    logic: str
    is_public: bool
    created_at: datetime

    class Config:
        from_attributes = True


# ── Trendline ────────────────────────────────────────────────
class TrendlineOut(BaseModel):
    id: int
    instrument_id: int
    symbol: Optional[str] = None
    timeframe: str
    line_type: Optional[str]
    slope: Optional[float]
    point_a_time: Optional[datetime]
    point_a_price: Optional[float]
    point_b_time: Optional[datetime]
    point_b_price: Optional[float]
    touches: int
    is_active: bool

    class Config:
        from_attributes = True
