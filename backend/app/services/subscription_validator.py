from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from app.models import User, Subscription
from datetime import datetime

# "expired" = 7-day free trial lapsed with no paid plan (see main.py gate map)
_TIER_ORDER = {"expired": -1, "free": 0, "eod_basic": 1, "eod_pro": 2, "ai_eod_pro": 3}
FREE_TRIAL_DAYS = 7

def _as_naive(v):
    """Subscription timestamps arrive as str (raw SQL) or datetime, tz-aware or not."""
    if v is None:
        return None
    if isinstance(v, str):
        try:
            return datetime.strptime(v.split(".")[0], "%Y-%m-%d %H:%M:%S")
        except Exception:
            try:
                return datetime.fromisoformat(v)
            except Exception:
                return None
    return v.replace(tzinfo=None) if getattr(v, "tzinfo", None) else v


async def _best_live_tier(user: User, db: AsyncSession):
    """Highest tier among the user's still-live subscriptions, else None.

    A user accumulates rows across renewals and upgrades, so pick the best plan
    that has not lapsed rather than the newest row — an expired weekly must not
    shadow a monthly that still has days left.
    """
    from app.api.subscription import LEGACY_TIER_ALIASES
    stmt = select(Subscription).where(
        Subscription.user_id == user.id, Subscription.status.in_(("active", "trial"))
    )
    now = datetime.utcnow()
    tiers = [
        s.tier.lower() for s in (await db.execute(stmt)).scalars().all()
        if _as_naive(s.expires_at) is None or _as_naive(s.expires_at) >= now
    ]
    if not tiers:
        return None
    return max(tiers, key=lambda t: _TIER_ORDER.get(LEGACY_TIER_ALIASES.get(t, t), -1))


async def validate_timeframe_access(user: User, timeframe: str, db: AsyncSession):
    """Enforce timeframe restrictions based on the user's active subscription tier.

    Tiers & Allowed Timeframes:
    - free, eod_basic: Only Daily ("D") is allowed.
    - eod_pro and above: Daily ("D"), Weekly ("W"), and Monthly ("M") are allowed.
    """
    if getattr(user, "is_admin", False):
        return

    tier = await _best_live_tier(user, db) or "free"

    # Load allowed timeframes for this tier
    from app.api.subscription import _get_tier_features
    features = _get_tier_features(tier)
    allowed_timeframes = features.get("timeframes", ["D"])

    tf = timeframe.strip()
    allowed_tf_lower = [t.lower() for t in allowed_timeframes]

    if tf.lower() not in allowed_tf_lower:
        raise HTTPException(
            status_code=403,
            detail="Weekly and Monthly timeframes are only available on the EOD Pro plan or above. Please upgrade your plan."
        )


# ── Generic tier resolution + gating helpers ─────────────────

async def get_user_tier(user: User, db: AsyncSession) -> str:
    """Resolve the user's effective base tier (weekly/legacy ids normalised).
    Admins count as the top tier."""
    if getattr(user, "is_admin", False):
        return "ai_eod_pro"
    tier = await _best_live_tier(user, db) or "free"
    if tier == "free":
        # No live plan — free access only inside the 7-day trial from signup.
        created = getattr(user, "created_at", None)
        if created is not None:
            if getattr(created, "tzinfo", None):
                created = created.replace(tzinfo=None)
            if (datetime.utcnow() - created).days >= FREE_TRIAL_DAYS:
                return "expired"
    from app.api.subscription import LEGACY_TIER_ALIASES
    return LEGACY_TIER_ALIASES.get(tier, tier)


async def require_tier(user: User, db: AsyncSession, min_tier: str, feature: str):
    """403 with an upgrade prompt when the user's tier is below min_tier."""
    tier = await get_user_tier(user, db)
    if _TIER_ORDER.get(tier, 0) < _TIER_ORDER.get(min_tier, 99):
        pretty = min_tier.replace("_", " ").title().replace("Eod", "EOD").replace("Ai ", "AI ")
        raise HTTPException(
            status_code=403,
            detail=f"{feature} is available on the {pretty} plan and above. Please upgrade your plan.",
        )
