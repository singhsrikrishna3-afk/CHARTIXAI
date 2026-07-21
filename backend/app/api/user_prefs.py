"""Chartix — Per-user preference store.

A small key→JSON store scoped to the authenticated user. Powers persistent,
account-bound chart layouts: indicator/signal parameters, indicator styles,
moving-average lines, price-scale mode, and per-symbol drawings (trendlines,
support/resistance, annotations).

A user can only read and write their own rows, so one user's layout can never
be seen or changed by anyone else.
"""

import logging
import re
from typing import Union

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models import UserPref, User
from app.auth import get_current_user

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/prefs", tags=["prefs"])

# Allow the known layout key plus per-symbol drawing keys ("drawings:RELIANCE").
_KEY_RE = re.compile(r"^[a-zA-Z0-9_:.\-]{1,120}$")
_MAX_BYTES = 512 * 1024  # 512 KB per key — plenty for a layout / drawing set


class PrefBody(BaseModel):
    value: Union[dict, list]


@router.get("/{key}")
async def get_pref(
    key: str,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    if not _KEY_RE.match(key):
        raise HTTPException(status_code=400, detail="Invalid key")
    row = (await db.execute(
        select(UserPref).where(UserPref.user_id == user.id, UserPref.pref_key == key)
    )).scalar_one_or_none()
    return {"key": key, "value": row.value if row else None}


@router.put("/{key}")
async def put_pref(
    key: str,
    body: PrefBody,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    if not _KEY_RE.match(key):
        raise HTTPException(status_code=400, detail="Invalid key")
    import json
    if len(json.dumps(body.value)) > _MAX_BYTES:
        raise HTTPException(status_code=413, detail="Preference payload too large")

    row = (await db.execute(
        select(UserPref).where(UserPref.user_id == user.id, UserPref.pref_key == key)
    )).scalar_one_or_none()
    if row:
        row.value = body.value
    else:
        db.add(UserPref(user_id=user.id, pref_key=key, value=body.value))
    await db.flush()
    await db.commit()
    return {"key": key, "saved": True}


@router.delete("/{key}", status_code=204)
async def delete_pref(
    key: str,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    if not _KEY_RE.match(key):
        raise HTTPException(status_code=400, detail="Invalid key")
    row = (await db.execute(
        select(UserPref).where(UserPref.user_id == user.id, UserPref.pref_key == key)
    )).scalar_one_or_none()
    if row:
        await db.delete(row)
        await db.commit()
