"""PEESTOCK — LSTM Price Forecast API."""

import logging
from datetime import date, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models import Instrument, Forecast, Subscription, User
from app.schemas import ForecastOut, ForecastDay
from app.auth import get_current_user

router = APIRouter(prefix="/api/forecasts", tags=["forecasts"])
logger = logging.getLogger(__name__)


async def _require_ai_forecast_access(user: User, db: AsyncSession):
    """AI Price Forecast (LSTM) is gated to the ai_eod_pro tier and above."""
    if getattr(user, "is_admin", False):
        return

    from app.api.subscription import _get_tier_features

    result = await db.execute(
        select(Subscription)
        .where(Subscription.user_id == user.id)
        .order_by(Subscription.created_at.desc())
        .limit(1)
    )
    sub = result.scalar_one_or_none()

    tier = "free"
    if sub and sub.status in ("active", "trial"):
        is_expired = False
        if sub.expires_at:
            expires_dt = sub.expires_at
            if isinstance(expires_dt, str):
                try:
                    expires_dt = datetime.strptime(expires_dt.split(".")[0], "%Y-%m-%d %H:%M:%S")
                except Exception:
                    expires_dt = datetime.fromisoformat(expires_dt)
            elif hasattr(expires_dt, "tzinfo") and expires_dt.tzinfo is not None:
                expires_dt = expires_dt.replace(tzinfo=None)
            is_expired = expires_dt < datetime.utcnow()
        if not is_expired:
            tier = sub.tier.lower()

    if not _get_tier_features(tier).get("ai_forecast", False):
        raise HTTPException(
            status_code=403,
            detail="AI Price Forecast (LSTM) is only available on the AI EOD Pro plan. Please upgrade your plan.",
        )


@router.get("/{symbol}", response_model=ForecastOut)
async def get_forecast(
    symbol: str,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    await _require_ai_forecast_access(user, db)

    inst = await db.execute(select(Instrument).where(Instrument.symbol == symbol.upper()))
    instrument = inst.scalar_one_or_none()
    if not instrument:
        raise HTTPException(status_code=404, detail="Symbol not found")

    latest_date_q = await db.execute(
        select(Forecast.as_of_date)
        .where(Forecast.instrument_id == instrument.id)
        .order_by(Forecast.as_of_date.desc())
        .limit(1)
    )
    latest_date = latest_date_q.scalar_one_or_none()
    if latest_date is None:
        raise HTTPException(status_code=404, detail="insufficient_history")

    rows_q = await db.execute(
        select(Forecast)
        .where(Forecast.instrument_id == instrument.id, Forecast.as_of_date == latest_date)
        .order_by(Forecast.horizon_day.asc())
    )
    rows = rows_q.scalars().all()

    is_stale = (date.today() - latest_date) > timedelta(days=1)

    return ForecastOut(
        symbol=instrument.symbol,
        as_of_date=latest_date,
        model_version=rows[0].model_version if rows else "unknown",
        is_stale=is_stale,
        days=[
            ForecastDay(
                horizon_day=r.horizon_day,
                predicted_close=float(r.predicted_close),
                lower_band=float(r.lower_band),
                upper_band=float(r.upper_band),
            )
            for r in rows
        ],
    )
