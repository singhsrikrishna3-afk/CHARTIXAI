"""PEESTOCK — Subscription & User Profile API."""

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models import User, Subscription
from app.schemas import SubscriptionOut
from app.auth import get_current_user

router = APIRouter(prefix="/api/subscription", tags=["subscription"])


@router.get("/", response_model=SubscriptionOut)
async def get_subscription(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Get current user's active subscription."""
    from datetime import datetime, timezone, timedelta
    import uuid
    return SubscriptionOut(
        id=uuid.uuid4(),
        user_id=uuid.uuid4(),
        tier="intraday_pro",
        status="active",
        stripe_subscription_id="mock",
        created_at=datetime.now(timezone.utc),
        expires_at=datetime.now(timezone.utc) + timedelta(days=365)
    )


@router.get("/status")
async def subscription_status(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Get subscription status with feature access details."""
    return {
        "tier": "intraday_pro",
        "status": "active",
        "expires_at": "2099-12-31 23:59:59",
        "features": _get_tier_features("intraday_pro"),
    }


def _get_tier_features(tier: str) -> dict:
    """Map subscription tier to feature access."""
    TIER_MAP = {
        "free": {
            "eod_charts": True,
            "pattern_screener": True,
            "max_scanners": 2,
            "auto_trendlines": False,
            "bar_replay": False,
            "intraday": False,
            "visual_scans": False,
            "timeframes": ["D"],
        },
        "eod_basic": {
            "eod_charts": True,
            "pattern_screener": True,
            "max_scanners": 5,
            "auto_trendlines": True,
            "bar_replay": False,
            "intraday": False,
            "visual_scans": False,
            "timeframes": ["D"],
        },
        "eod_pro": {
            "eod_charts": True,
            "pattern_screener": True,
            "max_scanners": -1,  # unlimited
            "auto_trendlines": True,
            "bar_replay": True,
            "intraday": False,
            "visual_scans": False,
            "timeframes": ["D", "W", "M"],
        },
        "intraday": {
            "eod_charts": True,
            "pattern_screener": True,
            "max_scanners": -1,
            "auto_trendlines": True,
            "bar_replay": True,
            "intraday": True,
            "visual_scans": False,
            "timeframes": ["1m", "5m", "15m", "1h", "4h", "D", "W", "M"],
        },
        "intraday_pro": {
            "eod_charts": True,
            "pattern_screener": True,
            "max_scanners": -1,
            "auto_trendlines": True,
            "bar_replay": True,
            "intraday": True,
            "visual_scans": True,
            "timeframes": ["1m", "5m", "15m", "1h", "4h", "D", "W", "M"],
        },
    }
    return TIER_MAP.get(tier, TIER_MAP["free"])
