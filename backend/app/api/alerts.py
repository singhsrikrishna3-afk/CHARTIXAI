"""PEESTOCK — Price/Pattern Alert Rules + In-App Notifications API."""

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select, desc
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models import Instrument, AlertRule, TriggeredAlert, User
from app.schemas import AlertRuleCreate, AlertRuleOut, TriggeredAlertOut
from app.auth import get_current_user

router = APIRouter(prefix="/api/alerts", tags=["alerts"])


# ── Telegram delivery linking ─────────────────────────────────
# Users link once: we mint a short code, they send `/start CODE` to the bot,
# the cron engine (scripts/check_alerts.py) matches it and saves their chat id.

@router.get("/telegram/status")
async def telegram_status(db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    from app.models import UserPref
    from app.services import notifier
    row = (await db.execute(select(UserPref).where(
        UserPref.user_id == user.id, UserPref.pref_key == "telegram_chat_id"
    ))).scalar_one_or_none()
    pending = (await db.execute(select(UserPref).where(
        UserPref.user_id == user.id, UserPref.pref_key == "telegram_link_code"
    ))).scalar_one_or_none()
    return {
        "enabled": notifier.telegram_enabled(),
        "bot": notifier.bot_username() or None,
        "linked": row is not None,
        "pending_code": (pending.value or {}).get("code") if pending else None,
    }


@router.post("/telegram/link")
async def telegram_link(db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    """Mint a link code. The user sends `/start <code>` to the bot to finish."""
    import secrets
    from app.models import UserPref
    from app.services import notifier
    if not notifier.telegram_enabled():
        raise HTTPException(status_code=503, detail="Telegram alerts are not configured yet on this server.")
    code = secrets.token_hex(3).upper()   # 6 hex chars — easy to type
    existing = (await db.execute(select(UserPref).where(
        UserPref.user_id == user.id, UserPref.pref_key == "telegram_link_code"
    ))).scalar_one_or_none()
    if existing:
        existing.value = {"code": code}
    else:
        db.add(UserPref(user_id=user.id, pref_key="telegram_link_code", value={"code": code}))
    await db.commit()
    return {"code": code, "bot": notifier.bot_username(),
            "instructions": f"Open Telegram, search @{notifier.bot_username()}, and send: /start {code}"}


@router.post("/telegram/unlink")
async def telegram_unlink(db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    from app.models import UserPref
    for key in ("telegram_chat_id", "telegram_link_code"):
        row = (await db.execute(select(UserPref).where(
            UserPref.user_id == user.id, UserPref.pref_key == key
        ))).scalar_one_or_none()
        if row:
            await db.delete(row)
    await db.commit()
    return {"linked": False}


@router.get("/rules", response_model=list[AlertRuleOut])
async def list_rules(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    rows = (await db.execute(
        select(AlertRule, Instrument)
        .outerjoin(Instrument, Instrument.id == AlertRule.instrument_id)
        .where(AlertRule.user_id == user.id,
               AlertRule.alert_type != "swing_events")  # internal carrier for system events
        .order_by(desc(AlertRule.created_at))
    )).all()

    return [
        AlertRuleOut(
            id=rule.id,
            symbol=inst.symbol if inst else None,
            alert_type=rule.alert_type,
            target_price=float(rule.target_price) if rule.target_price is not None else None,
            pattern_type=rule.pattern_type,
            is_active=rule.is_active,
            created_at=rule.created_at,
        )
        for rule, inst in rows
    ]


@router.post("/rules", response_model=AlertRuleOut, status_code=201)
async def create_rule(
    payload: AlertRuleCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    instrument_id = None
    if payload.symbol:
        inst = (await db.execute(
            select(Instrument).where(Instrument.symbol == payload.symbol.upper())
        )).scalar_one_or_none()
        if not inst:
            raise HTTPException(status_code=404, detail="Symbol not found")
        instrument_id = inst.id
    elif payload.alert_type != "pattern":
        raise HTTPException(status_code=400, detail="symbol is required for price alerts")

    if payload.alert_type in ("price_above", "price_below") and payload.target_price is None:
        raise HTTPException(status_code=400, detail="target_price is required for price alerts")

    rule = AlertRule(
        user_id=user.id,
        instrument_id=instrument_id,
        alert_type=payload.alert_type,
        target_price=payload.target_price,
        pattern_type=payload.pattern_type,
    )
    db.add(rule)
    await db.commit()
    await db.refresh(rule)

    return AlertRuleOut(
        id=rule.id, symbol=payload.symbol, alert_type=rule.alert_type,
        target_price=payload.target_price, pattern_type=rule.pattern_type,
        is_active=rule.is_active, created_at=rule.created_at,
    )


@router.delete("/rules/{rule_id}")
async def delete_rule(
    rule_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    rule = (await db.execute(
        select(AlertRule).where(AlertRule.id == rule_id, AlertRule.user_id == user.id)
    )).scalar_one_or_none()
    if not rule:
        raise HTTPException(status_code=404, detail="Alert rule not found")

    await db.delete(rule)
    await db.commit()
    return {"status": "deleted"}


@router.get("/notifications", response_model=list[TriggeredAlertOut])
async def list_notifications(
    unread_only: bool = False,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    q = (
        select(TriggeredAlert, Instrument)
        .join(Instrument, Instrument.id == TriggeredAlert.instrument_id)
        .where(TriggeredAlert.user_id == user.id)
    )
    if unread_only:
        q = q.where(TriggeredAlert.is_read == False)
    q = q.order_by(desc(TriggeredAlert.triggered_at)).limit(100)

    rows = (await db.execute(q)).all()
    return [
        TriggeredAlertOut(
            id=n.id, symbol=inst.symbol, message=n.message,
            triggered_at=n.triggered_at, is_read=n.is_read,
        )
        for n, inst in rows
    ]


@router.post("/notifications/{notification_id}/read")
async def mark_read(
    notification_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    n = (await db.execute(
        select(TriggeredAlert).where(
            TriggeredAlert.id == notification_id, TriggeredAlert.user_id == user.id
        )
    )).scalar_one_or_none()
    if not n:
        raise HTTPException(status_code=404, detail="Notification not found")

    n.is_read = True
    await db.commit()
    return {"status": "ok"}


@router.post("/notifications/read-all")
async def mark_all_read(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    rows = (await db.execute(
        select(TriggeredAlert).where(
            TriggeredAlert.user_id == user.id, TriggeredAlert.is_read == False
        )
    )).scalars().all()
    for n in rows:
        n.is_read = True
    await db.commit()
    return {"status": "ok", "marked": len(rows)}
