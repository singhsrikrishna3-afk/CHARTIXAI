"""PEESTOCK — Main FastAPI application."""

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware

from app.config import get_settings
from app.api.auth import router as auth_router
from app.api.password_reset import router as password_reset_router
from app.api.instruments import router as instruments_router
from app.api.screener import router as screener_router
from app.api.trendlines import router as trendlines_router
from app.api.scanners import router as scanners_router
from app.api.replay import router as replay_router
from app.api.subscription import router as subscription_router
from app.api.payments import router as payments_router
from app.api.scans import router as scans_router
from app.api.watchlist import router as watchlist_router
from app.api.chatbot import router as chatbot_router
from app.api.portfolio import router as portfolio_router
from app.api.alerts import router as alerts_router
from app.api.forecasts import router as forecasts_router
from app.api.ticker import router as ticker_router
from app.api.trade_plan import router as trade_plan_router
from app.api.user_prefs import router as user_prefs_router
from app.api.paper_trades import router as paper_trades_router
from app.api.backtest import router as backtest_router
from app.api.rrg import router as rrg_router
from app.api.market_analytics import router as market_analytics_router
from app.api.delivery import router as delivery_router

settings = get_settings()

app = FastAPI(
    title="Chartix API",
    description="Technical Analysis SaaS — Pattern Screener, No-Code Scanners, Bar Replay",
    version="0.2.0",
    docs_url="/api/docs",
    redoc_url="/api/redoc",
)

# Gzip large JSON responses (EOD history is ~700KB raw → ~150KB gzipped). Huge
# win over the tunnel where transfer latency, not backend compute, dominates.
app.add_middleware(GZipMiddleware, minimum_size=1024)

# CORS — origins loaded from config (set CORS_ORIGINS env var for production)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Subscription Tier Middleware ──────────────────────────────
# Tier hierarchy (ascending rank). A user's tier grants access to any route whose
# minimum required tier is at or below theirs, so premium tiers (ai_eod_pro)
# implicitly include everything the cheaper tiers can do. Previously this used a
# flat allow-list that omitted the *top* tiers — so ai_eod_pro / intraday_pro users
# were wrongly denied /api/scanners and /api/replay.
# "expired" = the 7-day free trial ran out with no paid plan → below free.
TIER_RANK = {"expired": -1, "free": 0, "eod_basic": 1, "eod_pro": 2, "ai_eod_pro": 3}
FREE_TRIAL_DAYS = 7
# Legacy tier names still present in the DB → canonical tier.
TIER_ALIASES = {"intraday": "eod_pro", "intraday_pro": "ai_eod_pro",
                # weekly plan ids grant the same access as their base tier
                "eod_basic_weekly": "eod_basic", "eod_pro_weekly": "eod_pro",
                "ai_eod_pro_weekly": "ai_eod_pro"}

# Minimum tier required to touch each protected route prefix — this map IS the
# pricing ladder (keep in sync with the pricing page + PLANS in payments.py).
# First matching prefix wins, so list specific paths before general ones.
# Middleware 403s carry CORS headers via _cors_headers_for (see below) so the
# browser shows the upgrade message, not "Failed to fetch".
# NOT gated: charts/EOD data, watchlist, portfolio, paper trades (capped
# in-endpoint), single-symbol trade plan, market regime, in-app alerts,
# replay (random-period mode gated in-endpoint; latest mode is free).
TIER_PROTECTED_ROUTES = {
    # -- AI EOD Pro --
    "/api/forecasts": "ai_eod_pro",
    "/api/trade-plan/top/360": "ai_eod_pro",
    # -- EOD Pro --
    "/api/trade-plan/top/recommendations": "eod_pro",
    "/api/scanners": "eod_pro",              # no-code custom scanner
    "/api/backtest": "eod_pro",              # strategy backtester
    "/api/alerts/telegram/link": "eod_pro",  # telegram delivery (status stays open)
    # -- EOD Basic --
    "/api/delivery": "eod_pro",
    "/api/scans": "eod_basic",               # MA/indicator/candlestick/other scans
    "/api/screener": "eod_basic",            # pattern screener with win rates
    # -- Free tier (7-day trial). Listed LAST: dict order is match order, so the
    # specific paths above win. Once the trial lapses these 403 too, which is what
    # turns "free forever" into "free for 7 days, then Basic".
    # NOT listed (always open): /api/auth, /api/subscription, /api/payments,
    # /api/ticker — an expired user must still be able to log in and pay.
    "/api/instruments": "free",              # charts / EOD data
    "/api/rrg": "free",
    "/api/watchlist": "free",
    "/api/portfolio": "free",
    "/api/paper-trades": "free",
    "/api/replay": "free",
    "/api/trade-plan": "free",               # single-symbol plan + market regime
    "/api/alerts": "free",                   # in-app alerts
    "/api/chatbot": "free",
}


def _tier_rank(tier: str) -> int:
    return TIER_RANK.get(TIER_ALIASES.get(tier, tier), -1)


def _cors_headers_for(request: "Request") -> dict:
    """Echo CORS headers for allowed origins so middleware-level responses (which
    short-circuit before CORSMiddleware runs) aren't blocked by the browser."""
    origin = request.headers.get("origin")
    if origin and origin in settings.cors_origins_list:
        return {"Access-Control-Allow-Origin": origin,
                "Access-Control-Allow-Credentials": "true", "Vary": "Origin"}
    return {}


@app.middleware("http")
async def subscription_gate_middleware(request: Request, call_next):
    """Check subscription tier for protected routes.

    Fast-fail middleware: decodes JWT, checks user's subscription tier
    against the route's required tiers. Returns 403 if insufficient.
    """
    path = request.url.path

    # Check if this path is tier-protected
    required_tier = None
    for route_prefix, min_tier in TIER_PROTECTED_ROUTES.items():
        if path.startswith(route_prefix):
            required_tier = min_tier
            break

    if required_tier is None:
        # Not a protected route — pass through
        return await call_next(request)

    # Extract JWT from Authorization header
    auth_header = request.headers.get("Authorization", "")
    if not auth_header.startswith("Bearer "):
        return await call_next(request)  # Let endpoint handle missing auth

    try:
        from jose import jwt as jose_jwt
        token = auth_header.split(" ", 1)[1]
        payload = jose_jwt.decode(
            token, settings.JWT_SECRET, algorithms=[settings.JWT_ALGORITHM]
        )
        user_id = payload.get("sub")
        if not user_id:
            return await call_next(request)

        # Resolve the effective tier: admin > active paid sub > free (inside the
        # 7-day trial) > expired. Kept here (not imported) so the middleware stays
        # a single fast query.
        from app.database import async_engine
        from sqlalchemy import text
        from sqlalchemy.ext.asyncio import AsyncSession
        from datetime import datetime, timedelta, timezone as tz

        def _parse_dt(v):
            """SQLite hands back naive strings or datetimes; normalise to naive UTC."""
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

        uid = user_id.replace("-", "")
        async with AsyncSession(async_engine) as session:
            urow = (await session.execute(
                text("SELECT is_admin, created_at FROM users WHERE id = :uid"), {"uid": uid}
            )).fetchone()
            if urow and urow[0]:
                return await call_next(request)          # admins bypass every gate
            subs = (await session.execute(
                text("SELECT tier, status, expires_at FROM subscriptions "
                     "WHERE user_id = :uid AND status IN ('active','trial')"), {"uid": uid}
            )).all()

        now = datetime.utcnow()
        tier = None
        # A user can hold several rows (renewals, upgrades). Honour the best plan
        # that is still live, not merely the newest row — an expired weekly must
        # not shadow a monthly that still has days left.
        live = [r for r in subs if _parse_dt(r[2]) is None or _parse_dt(r[2]) >= now]
        if live:
            tier = max((r[0] for r in live), key=_tier_rank)

        trial_left = None
        if tier is None:
            # No live plan → free only while inside the trial window from signup.
            created = _parse_dt(urow[1]) if urow else None
            if created is None:
                tier = "free"                             # unknown signup date → be generous
            else:
                age = (now - created).days
                if age < FREE_TRIAL_DAYS:
                    tier, trial_left = "free", FREE_TRIAL_DAYS - age
                else:
                    tier = "expired"

        if _tier_rank(tier) >= TIER_RANK[required_tier]:
            return await call_next(request)

        from fastapi.responses import JSONResponse
        if tier == "expired":
            detail = ("Your 7-day free trial has ended. Subscribe to EOD Basic "
                      "(₹99/week or ₹299/month) to keep using Chartix.")
        else:
            detail = (f"Your plan does not include this feature. Please upgrade."
                      + (f" (Free trial: {trial_left} day(s) left.)" if trial_left else ""))
        return JSONResponse(status_code=403,
                            content={"detail": detail, "tier": tier,
                                     "required_tier": required_tier,
                                     "trial_days_left": trial_left},
                            headers=_cors_headers_for(request))

    except Exception:
        # On any JWT/DB error, let the endpoint handle auth
        return await call_next(request)


# ── Routers ──────────────────────────────────────────────────
app.include_router(auth_router)
app.include_router(instruments_router)
app.include_router(screener_router)
app.include_router(trendlines_router)
app.include_router(scanners_router)
app.include_router(replay_router)
app.include_router(subscription_router)
app.include_router(payments_router)
app.include_router(scans_router)
app.include_router(watchlist_router)
app.include_router(chatbot_router)
app.include_router(portfolio_router)
app.include_router(alerts_router)
app.include_router(forecasts_router)
app.include_router(ticker_router)
app.include_router(trade_plan_router)
app.include_router(user_prefs_router)
app.include_router(paper_trades_router)
app.include_router(backtest_router)
app.include_router(rrg_router)
app.include_router(market_analytics_router)
app.include_router(delivery_router)
app.include_router(password_reset_router)


@app.on_event("startup")
async def _ensure_runtime_tables():
    """Create tables that aren't managed by the (data-seeded) alembic history yet,
    e.g. scan_history. checkfirst=True makes this a no-op when they exist."""
    try:
        from app.database import async_engine
        from app.models import ScanHistory, Fundamentals, UserPref, PaperTrade
        if async_engine is None:
            return
        async with async_engine.begin() as conn:
            await conn.run_sync(lambda sc: ScanHistory.__table__.create(sc, checkfirst=True))
            await conn.run_sync(lambda sc: Fundamentals.__table__.create(sc, checkfirst=True))
            await conn.run_sync(lambda sc: UserPref.__table__.create(sc, checkfirst=True))
            await conn.run_sync(lambda sc: PaperTrade.__table__.create(sc, checkfirst=True))
    except Exception as e:  # never block startup on this
        import logging
        logging.getLogger(__name__).warning("ensure_runtime_tables failed: %s", e)


@app.get("/api/health")
async def health_check():
    return {"status": "ok", "app": settings.APP_NAME, "version": "0.2.0"}
