"""PEESTOCK — Razorpay Payment Integration API.

Handles plan checkout, payment verification, and webhook processing.
"""

import hashlib
import hmac
import logging
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models import User, Subscription
from app.auth import get_current_user
from app.config import get_settings

logger = logging.getLogger(__name__)
settings = get_settings()

router = APIRouter(prefix="/api/payments", tags=["payments"])


# ── Plan Definitions ─────────────────────────────────────────
PLANS = {
    "eod_basic": {
        "name": "EOD Basic",
        "amount": 49900,  # in paise (₹499)
        "currency": "INR",
        "period_days": 30,
    },
    "eod_pro": {
        "name": "EOD Pro",
        "amount": 79900,  # ₹799
        "currency": "INR",
        "period_days": 30,
    },
    "intraday": {
        "name": "Intraday",
        "amount": 99900,  # ₹999
        "currency": "INR",
        "period_days": 30,
    },
    "intraday_pro": {
        "name": "Intraday Pro",
        "amount": 149900,  # ₹1,499
        "currency": "INR",
        "period_days": 30,
    },
}


class CheckoutRequest(BaseModel):
    plan_id: str  # e.g. "eod_basic", "intraday_pro"


class VerifyPaymentRequest(BaseModel):
    razorpay_order_id: str
    razorpay_payment_id: str
    razorpay_signature: str
    plan_id: str


@router.get("/plans")
async def list_plans():
    """Return available subscription plans."""
    return {
        key: {
            "id": key,
            "name": plan["name"],
            "price": plan["amount"] / 100,
            "currency": plan["currency"],
        }
        for key, plan in PLANS.items()
    }


@router.post("/checkout")
async def create_checkout(
    body: CheckoutRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Create a Razorpay order for the selected plan.

    Returns the order_id and key needed by the Razorpay JS SDK.
    """
    if body.plan_id not in PLANS:
        raise HTTPException(status_code=400, detail=f"Invalid plan: {body.plan_id}")

    plan = PLANS[body.plan_id]

    if not settings.RAZORPAY_KEY_ID or not settings.RAZORPAY_KEY_SECRET:
        raise HTTPException(
            status_code=503,
            detail="Payment gateway not configured. Contact support.",
        )

    try:
        import razorpay
        client = razorpay.Client(
            auth=(settings.RAZORPAY_KEY_ID, settings.RAZORPAY_KEY_SECRET)
        )

        order = client.order.create({
            "amount": plan["amount"],
            "currency": plan["currency"],
            "receipt": f"peestock_{user.id}_{body.plan_id}",
            "notes": {
                "user_id": str(user.id),
                "plan_id": body.plan_id,
                "email": user.email,
            },
        })

        return {
            "order_id": order["id"],
            "amount": plan["amount"],
            "currency": plan["currency"],
            "key": settings.RAZORPAY_KEY_ID,
            "plan": plan["name"],
            "user_email": user.email,
            "user_name": user.full_name or "",
        }

    except ImportError:
        raise HTTPException(
            status_code=503,
            detail="Razorpay SDK not installed. Run: pip install razorpay",
        )
    except Exception as e:
        logger.error(f"Razorpay order creation failed: {e}")
        raise HTTPException(status_code=500, detail="Failed to create order")


@router.post("/verify")
async def verify_payment(
    body: VerifyPaymentRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Verify Razorpay payment signature and activate subscription.

    This is called from the frontend after successful Razorpay checkout.
    """
    if body.plan_id not in PLANS:
        raise HTTPException(status_code=400, detail="Invalid plan")

    # Verify signature
    if not settings.RAZORPAY_KEY_SECRET:
        raise HTTPException(status_code=503, detail="Payment gateway not configured")

    message = f"{body.razorpay_order_id}|{body.razorpay_payment_id}"
    expected_signature = hmac.new(
        settings.RAZORPAY_KEY_SECRET.encode("utf-8"),
        message.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()

    if expected_signature != body.razorpay_signature:
        raise HTTPException(status_code=400, detail="Payment verification failed")

    plan = PLANS[body.plan_id]
    now = datetime.now(timezone.utc)

    # Create or update subscription
    new_sub = Subscription(
        user_id=user.id,
        tier=body.plan_id,
        status="active",
        starts_at=now,
        expires_at=now + timedelta(days=plan["period_days"]),
        razorpay_sub_id=body.razorpay_payment_id,
    )
    db.add(new_sub)
    await db.flush()

    logger.info(
        f"Subscription activated: user={user.id}, plan={body.plan_id}, "
        f"payment={body.razorpay_payment_id}"
    )

    return {
        "status": "success",
        "tier": body.plan_id,
        "expires_at": str(new_sub.expires_at),
        "message": f"Welcome to {plan['name']}! Your subscription is now active.",
    }


@router.post("/webhook")
async def razorpay_webhook(request: Request, db: AsyncSession = Depends(get_db)):
    """Handle Razorpay server-to-server webhooks.

    Verifies webhook signature and processes payment events.
    Set your Razorpay webhook URL to: https://yourdomain.com/api/payments/webhook
    """
    body = await request.body()
    signature = request.headers.get("X-Razorpay-Signature", "")

    if not settings.RAZORPAY_WEBHOOK_SECRET:
        logger.warning("Webhook received but RAZORPAY_WEBHOOK_SECRET not configured")
        return {"status": "ignored"}

    # Verify webhook signature
    expected = hmac.new(
        settings.RAZORPAY_WEBHOOK_SECRET.encode("utf-8"),
        body,
        hashlib.sha256,
    ).hexdigest()

    if expected != signature:
        logger.warning("Webhook signature mismatch")
        raise HTTPException(status_code=400, detail="Invalid webhook signature")

    import json
    payload = json.loads(body)
    event = payload.get("event", "")

    if event == "payment.captured":
        # Payment was successfully captured
        payment = payload["payload"]["payment"]["entity"]
        notes = payment.get("notes", {})
        user_id = notes.get("user_id")
        plan_id = notes.get("plan_id")

        if user_id and plan_id and plan_id in PLANS:
            plan = PLANS[plan_id]
            now = datetime.now(timezone.utc)
            new_sub = Subscription(
                user_id=user_id,
                tier=plan_id,
                status="active",
                starts_at=now,
                expires_at=now + timedelta(days=plan["period_days"]),
                razorpay_sub_id=payment["id"],
            )
            db.add(new_sub)
            await db.flush()
            await db.commit()
            logger.info(f"Webhook: subscription activated for user {user_id}")

    elif event == "payment.failed":
        logger.warning(f"Payment failed: {payload.get('payload', {}).get('payment', {}).get('entity', {}).get('id')}")

    return {"status": "ok"}
