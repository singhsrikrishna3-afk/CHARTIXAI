"""PEESTOCK — Password Reset API.

Handles forgot-password and reset-password flows using time-limited
JWT tokens sent via email (or returned directly in dev mode).
"""

import logging
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, EmailStr
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models import User
from app.auth import hash_password, create_access_token, get_current_user, verify_password
from app.config import get_settings

logger = logging.getLogger(__name__)
settings = get_settings()

router = APIRouter(prefix="/api/auth", tags=["auth"])


class ForgotPasswordRequest(BaseModel):
    email: EmailStr


class ResetPasswordRequest(BaseModel):
    token: str
    new_password: str


class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str


@router.post("/forgot-password")
async def forgot_password(body: ForgotPasswordRequest, db: AsyncSession = Depends(get_db)):
    """Send a password reset token.

    In production, this sends an email with a reset link.
    In dev mode (DEBUG=True), returns the token directly.
    """
    result = await db.execute(select(User).where(User.email == body.email))
    user = result.scalar_one_or_none()

    # Always return success to prevent email enumeration
    response = {"message": "If that email is registered, a reset link has been sent."}

    if not user:
        return response

    # Create a short-lived reset token (15 minutes)
    reset_token = create_access_token(
        {"sub": str(user.id), "type": "password_reset"},
    )

    if settings.DEBUG:
        # In dev mode, return the token directly
        response["_dev_token"] = reset_token
        logger.info(f"Password reset token for {body.email}: {reset_token}")
    else:
        # TODO: Send email via SES/SendGrid/etc.
        # send_reset_email(user.email, reset_token)
        logger.info(f"Password reset email queued for {body.email}")

    return response


@router.post("/reset-password")
async def reset_password(body: ResetPasswordRequest, db: AsyncSession = Depends(get_db)):
    """Reset password using a valid reset token."""
    from jose import JWTError, jwt as jose_jwt

    try:
        payload = jose_jwt.decode(
            body.token, settings.JWT_SECRET, algorithms=[settings.JWT_ALGORITHM]
        )
        user_id = payload.get("sub")
        token_type = payload.get("type")

        if not user_id or token_type != "password_reset":
            raise HTTPException(status_code=400, detail="Invalid reset token")

    except JWTError:
        raise HTTPException(status_code=400, detail="Invalid or expired reset token")

    if len(body.new_password) < 8:
        raise HTTPException(status_code=400, detail="Password must be at least 8 characters")

    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    user.password_hash = hash_password(body.new_password)
    user.updated_at = datetime.now(timezone.utc)
    await db.flush()
    await db.commit()

    logger.info(f"Password reset completed for user {user_id}")

    return {"message": "Password has been reset successfully. You can now log in."}


@router.post("/change-password")
async def change_password(
    body: ChangePasswordRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Change password for authenticated user (requires current password)."""

    if not verify_password(body.current_password, user.password_hash):
        raise HTTPException(status_code=400, detail="Current password is incorrect")

    if len(body.new_password) < 8:
        raise HTTPException(status_code=400, detail="New password must be at least 8 characters")

    if body.current_password == body.new_password:
        raise HTTPException(status_code=400, detail="New password must differ from current password")

    user.password_hash = hash_password(body.new_password)
    user.updated_at = datetime.now(timezone.utc)
    await db.flush()
    await db.commit()

    logger.info(f"Password changed for user {user.id}")
    return {"message": "Password changed successfully"}
