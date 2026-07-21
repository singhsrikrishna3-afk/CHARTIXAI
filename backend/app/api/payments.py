"""PEESTOCK — Razorpay Payment Integration API.

Handles plan checkout, payment verification, and webhook processing.
"""

import hashlib
import hmac
import logging
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Request, Query
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
# Priced against what Indian retail traders already pay: Chartink ₹400-700,
# Trendlyne ₹500-1500, StockEdge ₹500-1000/mo. Undercut to convert; ai_eod_pro
# anchors the ladder so most buyers land on eod_pro.
#
# Every tier has a WEEKLY variant (impulse-friendly entry price; ~4.3 weeks
# costs ~30% more than monthly, so monthly stays the obvious value). The plan id
# is stored as the subscription tier, so weekly ids are aliased to their base
# tier wherever tiers are ranked (main.py TIER_ALIASES, subscription.py
# LEGACY_TIER_ALIASES) — access is identical, only the period differs.
PLANS = {
    "eod_basic_weekly": {
        "name": "EOD Basic (Weekly)",
        "amount": 9900,   # ₹99 / week
        "currency": "INR",
        "period_days": 7,
    },
    "eod_basic": {
        "name": "EOD Basic",
        "amount": 29900,  # ₹299 / month
        "currency": "INR",
        "period_days": 30,
    },
    "eod_pro_weekly": {
        "name": "EOD Pro (Weekly)",
        "amount": 19900,  # ₹199 / week
        "currency": "INR",
        "period_days": 7,
    },
    "eod_pro": {
        "name": "EOD Pro",
        "amount": 59900,  # ₹599 / month
        "currency": "INR",
        "period_days": 30,
    },
    "ai_eod_pro_weekly": {
        "name": "AI EOD Pro (Weekly)",
        "amount": 29900,  # ₹299 / week
        "currency": "INR",
        "period_days": 7,
    },
    "ai_eod_pro": {
        "name": "AI EOD Pro",
        "amount": 99900,  # ₹999 / month
        "currency": "INR",
        "period_days": 30,
    },
}


class CheckoutRequest(BaseModel):
    plan_id: str  # e.g. "eod_basic", "eod_pro", "ai_eod_pro"


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
            "period_days": plan["period_days"],
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

    if not hmac.compare_digest(expected_signature, body.razorpay_signature):
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


# ── UPI Payment Integration ──────────────────────────────────
class UpiInfoResponse(BaseModel):
    upi_id: str
    recipient_name: str
    amount: float
    currency: str
    transaction_note: str
    upi_uri: str
    plan_name: str


class UpiVerifyRequest(BaseModel):
    plan_id: str
    utr_ref: str
    transaction_note: str


@router.get("/upi-info", response_model=UpiInfoResponse)
async def get_upi_info(
    plan_id: str = Query(...),
    user: User = Depends(get_current_user),
):
    """Retrieve UPI payment details and deep-link URI for a plan."""
    if plan_id not in PLANS:
        raise HTTPException(status_code=400, detail="Invalid plan ID")

    plan = PLANS[plan_id]
    amount_inr = plan["amount"] / 100

    # Generate unique transaction note: peestock-user_short-timestamp
    import time
    user_id_short = str(user.id)[:8]
    note = f"peestock-{user_id_short}-{int(time.time())}"

    # Recipient details
    upi_id = settings.UPI_ID
    recipient_name = settings.UPI_NAME

    import urllib.parse
    encoded_name = urllib.parse.quote(recipient_name)
    encoded_note = urllib.parse.quote(note)
    upi_uri = f"upi://pay?pa={upi_id}&pn={encoded_name}&am={amount_inr:.2f}&cu=INR&tn={encoded_note}"

    return UpiInfoResponse(
        upi_id=upi_id,
        recipient_name=recipient_name,
        amount=amount_inr,
        currency="INR",
        transaction_note=note,
        upi_uri=upi_uri,
        plan_name=plan["name"],
    )


@router.post("/upi-verify")
async def verify_upi_payment(
    body: UpiVerifyRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Verify UPI transaction reference (UTR) and activate plan."""
    if body.plan_id not in PLANS:
        raise HTTPException(status_code=400, detail="Invalid plan ID")

    # Validate UTR format (UPI Transaction Reference / UTR is a 12-digit numeric code)
    import re
    if not re.match(r"^\d{12}$", body.utr_ref):
        raise HTTPException(
            status_code=400,
            detail="Invalid UPI Reference Number (UTR). Must be exactly 12 numeric digits.",
        )

    # Check if this UTR has already been submitted to prevent reuse
    result = await db.execute(
        select(Subscription).where(Subscription.razorpay_sub_id == body.utr_ref)
    )
    existing_sub = result.scalar_one_or_none()
    if existing_sub:
        raise HTTPException(
            status_code=400,
            detail="This Transaction ID (UTR) has already been used to claim a subscription.",
        )

    plan = PLANS[body.plan_id]
    now = datetime.now(timezone.utc)

    # Create pending subscription — admin must approve before it activates
    new_sub = Subscription(
        user_id=user.id,
        tier=body.plan_id,
        status="pending",
        starts_at=None,
        expires_at=None,
        razorpay_sub_id=body.utr_ref,
    )
    db.add(new_sub)
    await db.flush()

    logger.info(
        f"UPI payment pending admin approval: user={user.id}, plan={body.plan_id}, "
        f"utr={body.utr_ref}"
    )

    return {
        "status": "pending",
        "tier": body.plan_id,
        "message": "Payment received — your subscription will be activated within a few hours once we verify the transaction.",
    }


# ── Admin Payment Management ─────────────────────────────────

@router.get("/pending")
async def list_pending_payments(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """List pending UPI payments awaiting admin approval."""
    if not current_user.is_admin:
        raise HTTPException(status_code=403, detail="Admin only")

    result = await db.execute(
        select(Subscription, User)
        .join(User, Subscription.user_id == User.id)
        .where(Subscription.status == "pending")
        .order_by(Subscription.created_at.desc())
    )
    rows = result.all()

    return [
        {
            "sub_id": str(sub.id),
            "user_email": user.email,
            "tier": sub.tier,
            "utr": sub.razorpay_sub_id,
            "created_at": sub.created_at.isoformat() if sub.created_at else None,
            "amount": PLANS.get(sub.tier, {}).get("amount", 0) / 100,
        }
        for sub, user in rows
    ]


@router.post("/approve/{sub_id}")
async def approve_payment(
    sub_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Activate a pending UPI subscription after admin verifies the UTR."""
    if not current_user.is_admin:
        raise HTTPException(status_code=403, detail="Admin only")

    result = await db.execute(
        select(Subscription).where(Subscription.id == sub_id, Subscription.status == "pending")
    )
    sub = result.scalar_one_or_none()
    if not sub:
        raise HTTPException(status_code=404, detail="Pending subscription not found")

    plan = PLANS.get(sub.tier, {})
    now = datetime.now(timezone.utc)
    sub.status = "active"
    sub.starts_at = now
    sub.expires_at = now + timedelta(days=plan.get("period_days", 30))
    await db.flush()

    logger.info(f"Admin approved UPI payment: sub={sub_id}, admin={current_user.id}")

    return {"status": "success", "message": f"Subscription {sub_id} approved and activated."}


@router.post("/reject/{sub_id}")
async def reject_payment(
    sub_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Reject a pending UPI subscription (invalid UTR)."""
    if not current_user.is_admin:
        raise HTTPException(status_code=403, detail="Admin only")

    result = await db.execute(
        select(Subscription).where(Subscription.id == sub_id, Subscription.status == "pending")
    )
    sub = result.scalar_one_or_none()
    if not sub:
        raise HTTPException(status_code=404, detail="Pending subscription not found")

    sub.status = "rejected"
    await db.flush()

    logger.info(f"Admin rejected UPI payment: sub={sub_id}, admin={current_user.id}")

    return {"status": "success", "message": f"Subscription {sub_id} rejected."}

