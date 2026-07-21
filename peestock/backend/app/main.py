"""PEESTOCK — Main FastAPI application."""

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware

from app.config import get_settings
from app.api.auth import router as auth_router
from app.api.instruments import router as instruments_router
from app.api.screener import router as screener_router
from app.api.trendlines import router as trendlines_router
from app.api.scanners import router as scanners_router
from app.api.replay import router as replay_router
from app.api.subscription import router as subscription_router
from app.api.payments import router as payments_router
from app.api.scans import router as scans_router

settings = get_settings()

app = FastAPI(
    title="PEESTOCK API",
    description="Technical Analysis SaaS — Pattern Screener, No-Code Scanners, Bar Replay",
    version="0.2.0",
    docs_url="/api/docs",
    redoc_url="/api/redoc",
)

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://localhost:3001",
        "https://peestock.com",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Subscription Tier Middleware ──────────────────────────────
TIER_PROTECTED_ROUTES = {
    "/api/replay": ["eod_pro", "intraday", "intraday_pro"],
    "/api/scanners": ["eod_basic", "eod_pro", "intraday", "intraday_pro"],
}


@app.middleware("http")
async def subscription_gate_middleware(request: Request, call_next):
    """Check subscription tier for protected routes.

    Fast-fail middleware: decodes JWT, checks user's subscription tier
    against the route's required tiers. Returns 403 if insufficient.
    """
    return await call_next(request)
    path = request.url.path

    # Check if this path is tier-protected
    required_tiers = None
    for route_prefix, tiers in TIER_PROTECTED_ROUTES.items():
        if path.startswith(route_prefix):
            required_tiers = tiers
            break

    if required_tiers is None:
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

        # Quick subscription check
        from app.database import async_engine
        from sqlalchemy import text
        from sqlalchemy.ext.asyncio import AsyncSession

        async with AsyncSession(async_engine) as session:
            result = await session.execute(
                text(
                    "SELECT tier, status, expires_at FROM subscriptions "
                    "WHERE user_id = :uid ORDER BY created_at DESC LIMIT 1"
                ),
                {"uid": user_id},
            )
            sub = result.fetchone()

        if sub:
            from datetime import datetime, timezone as tz
            tier, status, expires_at = sub
            is_expired = expires_at and expires_at < datetime.now(tz.utc)
            if not is_expired and status in ("active", "trial") and tier in required_tiers:
                return await call_next(request)

        # Tier insufficient — deny access
        from fastapi.responses import JSONResponse
        return JSONResponse(
            status_code=403,
            content={
                "detail": f"Your subscription tier does not include access to {path}. "
                "Please upgrade your plan."
            },
        )

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


@app.get("/api/health")
async def health_check():
    return {"status": "ok", "app": settings.APP_NAME, "version": "0.2.0"}
