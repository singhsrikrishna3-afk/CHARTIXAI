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
    is_admin = getattr(user, "is_admin", False)
    if is_admin:
        import uuid
        from datetime import datetime, timedelta
        return Subscription(
            id=uuid.uuid4(),
            user_id=user.id,
            tier="ai_eod_pro",
            status="active",
            starts_at=datetime.utcnow(),
            expires_at=datetime.utcnow() + timedelta(days=365)
        )

    result = await db.execute(
        select(Subscription)
        .where(Subscription.user_id == user.id)
        .order_by(Subscription.created_at.desc())
        .limit(1)
    )
    sub = result.scalar_one_or_none()
    if not sub:
        # Create a default trial subscription if one doesn't exist
        from datetime import datetime, timezone, timedelta
        sub = Subscription(
            user_id=user.id,
            tier="free",
            status="trial",
            starts_at=datetime.now(timezone.utc),
            expires_at=datetime.now(timezone.utc) + timedelta(days=14),
        )
        db.add(sub)
        await db.flush()
    return sub


@router.get("/status")
async def subscription_status(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Get subscription status with feature access details."""
    is_admin = getattr(user, "is_admin", False)
    if is_admin:
        return {
            "tier": "ai_eod_pro",
            "status": "active",
            "expires_at": None,
            "features": _get_tier_features("ai_eod_pro"),
        }

    result = await db.execute(
        select(Subscription)
        .where(Subscription.user_id == user.id)
        .order_by(Subscription.created_at.desc())
        .limit(1)
    )
    sub = result.scalar_one_or_none()

    tier = "free"
    status = "trial"
    expires_at = None

    if sub:
        tier = sub.tier
        status = sub.status
        expires_at = sub.expires_at

    # Validate expiry safely with SQLite naive/aware compatibility
    if expires_at:
        from datetime import datetime, timezone as tz
        expires_now = datetime.now(tz.utc) if expires_at.tzinfo is not None else datetime.utcnow()
        if expires_at < expires_now:
            status = "expired"

    return {
        "tier": tier,
        "status": status,
        "expires_at": str(expires_at) if expires_at else None,
        "features": _get_tier_features(tier),
    }



LEGACY_TIER_ALIASES = {
    "intraday": "eod_pro",
    "intraday_pro": "ai_eod_pro",
    # weekly plan ids grant the same access as their base tier
    "eod_basic_weekly": "eod_basic",
    "eod_pro_weekly": "eod_pro",
    "ai_eod_pro_weekly": "ai_eod_pro",
}


def _get_tier_features(tier: str) -> dict:
    """Map subscription tier to feature access."""
    tier = LEGACY_TIER_ALIASES.get(tier, tier)
    TIER_MAP = {
        "free": {
            "eod_charts": True,
            "pattern_screener": True,
            "max_scanners": 2,
            "auto_trendlines": False,
            "bar_replay": False,
            "visual_scans": False,
            "ai_forecast": False,
            "timeframes": ["D"],
        },
        "eod_basic": {
            "eod_charts": True,
            "pattern_screener": True,
            "max_scanners": 5,
            "auto_trendlines": True,
            "bar_replay": False,
            "visual_scans": False,
            "ai_forecast": False,
            "timeframes": ["D"],
        },
        "eod_pro": {
            "eod_charts": True,
            "pattern_screener": True,
            "max_scanners": -1,  # unlimited
            "auto_trendlines": True,
            "bar_replay": True,
            "visual_scans": True,
            "ai_forecast": False,
            "timeframes": ["D", "W", "M"],
        },
        "ai_eod_pro": {
            "eod_charts": True,
            "pattern_screener": True,
            "max_scanners": -1,  # unlimited
            "auto_trendlines": True,
            "bar_replay": True,
            "visual_scans": True,
            "ai_forecast": True,
            "timeframes": ["D", "W", "M"],
        },
    }
    return TIER_MAP.get(tier, TIER_MAP["free"])
