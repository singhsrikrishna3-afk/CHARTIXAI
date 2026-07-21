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
    is_admin: bool = False
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
    # Nullable in the DB (a no-expiry / not-yet-started plan). They were declared
    # required here, so any record with a null date made GET /subscription/ 500 —
    # which silently defaulted callers to the free tier and wrongly gated premium
    # features. Consumers already guard with `expires_at && …`, so Optional is safe.
    starts_at: Optional[datetime] = None
    expires_at: Optional[datetime] = None

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
    sector: Optional[str] = None
    industry: Optional[str] = None

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


# ── Forecast ─────────────────────────────────────────────────
class ForecastDay(BaseModel):
    horizon_day: int
    predicted_close: float
    lower_band: float
    upper_band: float

    class Config:
        from_attributes = True


class ForecastOut(BaseModel):
    symbol: str
    as_of_date: date
    model_version: str
    is_stale: bool
    days: list[ForecastDay]


# ── Pattern ──────────────────────────────────────────────────
class PatternOut(BaseModel):
    id: int
    symbol: Optional[str] = None
    sector: Optional[str] = None
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


class ScannerPreview(BaseModel):
    """Ad-hoc scan run — no name required (used by POST /scanners/preview)."""
    conditions: list[ScannerCondition]
    logic: str = "AND"  # 'AND' / 'OR'


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


# ── Watchlist ────────────────────────────────────────────────
class WatchlistItemOut(BaseModel):
    symbol: str
    name: str
    sector: Optional[str] = None
    price: float
    change: float
    change_pct: float
    volume: int
    added_at: datetime


# ── Portfolio ────────────────────────────────────────────────
class PortfolioPositionCreate(BaseModel):
    symbol: str
    quantity: float = Field(gt=0)
    buy_price: float = Field(gt=0)
    buy_date: date
    notes: Optional[str] = None


class PortfolioPositionOut(BaseModel):
    id: int
    symbol: str
    name: str
    quantity: float
    buy_price: float
    buy_date: date
    notes: Optional[str] = None
    current_price: Optional[float] = None
    invested: float
    current_value: Optional[float] = None
    pnl: Optional[float] = None
    pnl_pct: Optional[float] = None
    created_at: datetime


# ── Alerts ───────────────────────────────────────────────────
class AlertRuleCreate(BaseModel):
    symbol: Optional[str] = None  # None = applies to any/all symbols (pattern alerts only)
    alert_type: str  # 'price_above', 'price_below', 'pattern'
    target_price: Optional[float] = None
    pattern_type: Optional[str] = None  # None = any pattern type

    @field_validator("alert_type")
    @classmethod
    def validate_alert_type(cls, v):
        if v not in ("price_above", "price_below", "pattern"):
            raise ValueError("alert_type must be 'price_above', 'price_below', or 'pattern'")
        return v


class AlertRuleOut(BaseModel):
    id: int
    symbol: Optional[str] = None
    alert_type: str
    target_price: Optional[float] = None
    pattern_type: Optional[str] = None
    is_active: bool
    created_at: datetime


class TriggeredAlertOut(BaseModel):
    id: int
    symbol: str
    message: str
    triggered_at: datetime
    is_read: bool
