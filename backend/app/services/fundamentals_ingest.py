"""Chartix — fundamentals ingestion.

Fetches per-instrument fundamental snapshots (currently from Yahoo Finance via
yfinance; the mapping lives in one function so the source can be swapped for a
licensed feed later) and upserts them into the `fundamentals` table.

Only NSE equities (segment EQ) have Yahoo fundamentals — commodities/forex/indices
are skipped. Symbols map as `<SYMBOL>.NS` (Yahoo accepts '&' and '-' verbatim,
e.g. M&M.NS, BAJAJ-AUTO.NS).

Run modes:
  - scripts/backfill_fundamentals.py [N|all]  — manual/initial backfill
  - nightly Celery task (see app/workers) once workers are running
"""
from __future__ import annotations

import logging
import time
from datetime import datetime

logger = logging.getLogger(__name__)

# yfinance .info fields → our columns, with unit normalization.
# Fractions → percent: roe, revenue_growth, earnings_growth, profit_margin,
# promoter_holding.  debtToEquity arrives as percent → ratio (/100).
# dividendYield arrives already in percent in yfinance >= 1.x.


def _num(v):
    try:
        f = float(v)
        return f if f == f and abs(f) < 1e15 else None  # NaN/inf guard
    except (TypeError, ValueError):
        return None


def _pct(v):
    f = _num(v)
    return round(f * 100, 2) if f is not None else None


def map_info_to_row(info: dict) -> dict:
    """Normalize a yfinance `.info` dict into fundamentals column values."""
    d2e = _num(info.get("debtToEquity"))
    return {
        "market_cap": int(info["marketCap"]) if _num(info.get("marketCap")) else None,
        "pe": _num(info.get("trailingPE")),
        "forward_pe": _num(info.get("forwardPE")),
        "pb": _num(info.get("priceToBook")),
        "roe": _pct(info.get("returnOnEquity")),
        "debt_to_equity": round(d2e / 100, 2) if d2e is not None else None,
        "dividend_yield": _num(info.get("dividendYield")),
        "eps": _num(info.get("trailingEps")),
        "revenue_growth": _pct(info.get("revenueGrowth")),
        "earnings_growth": _pct(info.get("earningsGrowth")),
        "profit_margin": _pct(info.get("profitMargins")),
        "book_value": _num(info.get("bookValue")),
        "week52_high": _num(info.get("fiftyTwoWeekHigh")),
        "week52_low": _num(info.get("fiftyTwoWeekLow")),
        "promoter_holding": _pct(info.get("heldPercentInsiders")),
        "sector_src": (info.get("sector") or None),
        "industry_src": (info.get("industry") or None),
    }


def fetch_symbol(symbol: str) -> dict | None:
    """Fetch one symbol's fundamentals from Yahoo. Returns column dict or None."""
    import yfinance as yf
    try:
        info = yf.Ticker(f"{symbol}.NS").info or {}
    except Exception as e:  # noqa: BLE001 — a bad symbol must not stop the run
        logger.warning("fundamentals fetch failed for %s: %s", symbol, e)
        return None
    # Yahoo returns a near-empty dict for unknown tickers.
    if not info.get("marketCap") and not info.get("trailingPE") and not info.get("bookValue"):
        return None
    return map_info_to_row(info)


def run_sync(limit: int | None = None, delay: float = 0.6) -> dict:
    """Synchronous ingestion over active EQ instruments (largest first so the
    most-viewed names are covered even in a partial run). Safe to re-run —
    upserts by instrument_id. Returns counters."""
    import sqlite3
    from app.config import get_settings, DEFAULT_DB_PATH

    url = get_settings().DATABASE_URL
    db_path = url.split("///")[-1].split("?")[0] if "sqlite" in url else DEFAULT_DB_PATH
    con = sqlite3.connect(db_path, timeout=60)
    con.execute("PRAGMA busy_timeout=60000")

    rows = con.execute(
        "SELECT i.id, i.symbol FROM instruments i "
        "LEFT JOIN (SELECT instrument_id, MAX(volume*close) mv FROM ohlcv_eod "
        "           WHERE time >= date('now','-30 day') GROUP BY instrument_id) t "
        "  ON t.instrument_id = i.id "
        "WHERE i.is_active = 1 AND i.segment = 'EQ' "
        "ORDER BY COALESCE(t.mv, 0) DESC"
    ).fetchall()
    if limit:
        rows = rows[:limit]

    cols = list(map_info_to_row({}).keys())
    placeholders = ", ".join("?" for _ in cols)
    setters = ", ".join(f"{c}=excluded.{c}" for c in cols)
    sql = (
        f"INSERT INTO fundamentals (instrument_id, {', '.join(cols)}, updated_at) "
        f"VALUES (?, {placeholders}, ?) "
        f"ON CONFLICT(instrument_id) DO UPDATE SET {setters}, updated_at=excluded.updated_at"
    )

    ok = skipped = failed = 0
    for iid, symbol in rows:
        data = fetch_symbol(symbol)
        if data is None:
            skipped += 1
        else:
            try:
                con.execute(sql, [iid] + [data[c] for c in cols] + [datetime.utcnow().isoformat()])
                con.commit()
                ok += 1
            except Exception as e:  # noqa: BLE001
                logger.warning("fundamentals upsert failed for %s: %s", symbol, e)
                failed += 1
        time.sleep(delay)  # be polite to Yahoo; full universe ≈ 25-40 min
    con.close()
    return {"fetched": ok, "skipped_no_data": skipped, "failed": failed, "candidates": len(rows)}
