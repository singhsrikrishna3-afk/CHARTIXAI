"""Chartix — persistent scan history.

Records every executed scan (params + full result set + timestamp) to the
`scan_history` table. Best-effort: a failure here must never break the scan
itself, so everything is wrapped and logged.
"""
from __future__ import annotations

import logging

logger = logging.getLogger(__name__)

# Cap stored matches so a single history row can't balloon the DB.
_MAX_STORED_MATCHES = 200


def _jsonable(value):
    """Coerce match rows to JSON-safe dicts (handles pydantic models too)."""
    if isinstance(value, list):
        out = []
        for m in value:
            if hasattr(m, "model_dump"):
                out.append(m.model_dump(mode="json"))
            elif isinstance(m, dict):
                out.append(m)
            else:
                out.append(str(m))
        return out
    return value


async def record(user_id, scan_type: str, params, matches) -> None:
    """Persist one scan run in its own session/transaction so it can never
    interfere with the request's DB session. Never raises."""
    from app.models import ScanHistory
    from app.database import AsyncSessionLocal
    try:
        safe_matches = _jsonable(matches if isinstance(matches, list) else [])
        async with AsyncSessionLocal() as session:
            session.add(ScanHistory(
                user_id=user_id,
                scan_type=scan_type,
                params=params if isinstance(params, (dict, list)) else {"value": str(params)},
                result_count=len(safe_matches),
                matches=safe_matches[:_MAX_STORED_MATCHES],
            ))
            await session.commit()
    except Exception as e:  # noqa: BLE001 — history must never break a scan
        logger.warning("scan_history.record(%s) failed: %s", scan_type, e)
