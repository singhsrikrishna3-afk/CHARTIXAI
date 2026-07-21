"""Chartix — in-process TTL cache for scan results.

Scan outputs depend only on market data + parameters (not on the requesting user),
and EOD data changes at most once a day — so results are safe to memoise for a
short window. This caches every scan for 15 minutes, keyed by a hash of its
parameters, which makes repeat runs instant and spares the memory-constrained box
from recomputing full-universe scans on every click.

Single-process (uvicorn without --workers), so a plain dict + lock is sufficient.
Subscription gating still runs on every request *before* the cache is consulted,
so caching never leaks gated access.
"""
from __future__ import annotations

import hashlib
import json
import threading
import time

DEFAULT_TTL = 15 * 60  # 15 minutes
_MAX_ENTRIES = 500

_CACHE: dict[str, tuple[object, float]] = {}
_LOCK = threading.Lock()


def make_key(namespace: str, params: dict | list | tuple) -> str:
    """Stable cache key from a scan namespace + its parameters."""
    raw = json.dumps(params, sort_keys=True, default=str)
    digest = hashlib.sha256(raw.encode()).hexdigest()
    return f"{namespace}:{digest}"


def get(key: str):
    with _LOCK:
        entry = _CACHE.get(key)
        if entry is None:
            return None
        value, expires_at = entry
        if time.time() > expires_at:
            _CACHE.pop(key, None)
            return None
        return value


def set(key: str, value, ttl: int = DEFAULT_TTL) -> None:
    now = time.time()
    with _LOCK:
        # Opportunistic eviction of expired / overflow entries.
        if len(_CACHE) >= _MAX_ENTRIES:
            for k in [k for k, (_, exp) in _CACHE.items() if exp < now]:
                _CACHE.pop(k, None)
            if len(_CACHE) >= _MAX_ENTRIES:
                # still full: drop the soonest-to-expire entry
                oldest = min(_CACHE, key=lambda k: _CACHE[k][1])
                _CACHE.pop(oldest, None)
        _CACHE[key] = (value, now + ttl)


def clear() -> None:
    with _LOCK:
        _CACHE.clear()
