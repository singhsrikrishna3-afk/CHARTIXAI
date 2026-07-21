#!/usr/bin/env python
"""PEESTOCK — Advanced Price Spike and Corporate Action Repairer.

This script scans the database for:
1. Price cliffs caused by stock splits, bonuses, or large dividends.
2. Isolated single-day price spikes/glitches not explained by a corporate action.
3. Unadjusted Saturday/Sunday records left over from raw historical seeding.

Corporate-action cliffs are repaired by rescaling the instrument's own
pre-jump history in place (NSE bhavcopy stays the single source of truth).
We deliberately do NOT pull a second vendor's (Yahoo Finance) adjusted
series to overwrite history: that vendor applies dividend/split adjustment
continuously while NSE bhavcopy ingestion keeps writing raw prices every
day, so any overwrite-from-Yahoo approach re-introduces a fresh artificial
cliff at the boundary the next time it runs — a self-perpetuating bug, not
a fix. Ratio-rescaling is deterministic, vendor-free, and idempotent.
"""

import os
import sys
import sqlite3
import logging
from datetime import datetime, date
from typing import Optional
import pandas as pd

# Configure logging
logging.basicConfig(level=logging.INFO, format="%(asctime)s — %(levelname)s — %(message)s")
logger = logging.getLogger(__name__)

# Add backend to path
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from app.config import get_settings

settings = get_settings()
# Clean database URL to get file path if sqlite
DB_URL = settings.DATABASE_URL.replace("+asyncpg", "").replace("+aiosqlite", "").replace("sqlite+aiosqlite:///", "sqlite:///").replace("sqlite+aiosqlite://", "sqlite://")

def get_db_connection():
    if DB_URL.startswith("sqlite"):
        db_path = DB_URL.replace("sqlite:///", "").replace("sqlite://", "")
        if "?" in db_path:
            db_path = db_path.split("?")[0]
        return sqlite3.connect(db_path)
    else:
        # Fallback for PostgreSQL if needed in production
        import psycopg2
        # Strip sqlite or other drivers
        pg_url = DB_URL.replace("postgresql+psycopg2://", "postgresql://")
        return psycopg2.connect(pg_url)




def find_suspect_instruments(conn):
    """Scan the database to find instruments with major price anomalies or Saturday records."""
    cursor = conn.cursor()
    
    # Query to find instruments with:
    # 1. Any day-to-day price change > 30% (either up or down).
    # 2. Any records on Saturdays or Sundays.
    # We exclude very low price stocks (< 0.5 INR) to avoid penny stock volatility noise.
    query = """
        WITH ranked AS (
            SELECT 
                instrument_id, 
                time, 
                close,
                strftime('%w', time) as day_of_week,
                LAG(close) OVER (PARTITION BY instrument_id ORDER BY time) as prev_close
            FROM ohlcv_eod
        )
        SELECT DISTINCT r.instrument_id, i.symbol, i.segment
        FROM ranked r
        JOIN instruments i ON r.instrument_id = i.id
        WHERE 
            (
                r.prev_close IS NOT NULL 
                AND r.close > 0.5 
                AND r.prev_close > 0.5 
                AND (r.close < 0.7 * r.prev_close OR r.close > 1.3 * r.prev_close)
            )
            OR (r.day_of_week IN ('0', '6'))
    """
    cursor.execute(query)
    rows = cursor.fetchall()
    return rows


# Ratios a genuine split/bonus/consolidation can produce, e.g. a 2:1 split
# halves price (ratio 0.5), a 1:5 bonus issue divides price by 6 (ratio
# 1/6), a reverse merger could double it (ratio 2.0). An ordinary volatile
# trading day essentially never lands within RATIO_TOLERANCE of one of
# these clean fractions, so this is what distinguishes "real corporate
# action" from "stock just moved a lot."
SPLIT_RATIOS = [
    1 / 2, 1 / 3, 1 / 4, 1 / 5, 1 / 10, 1 / 20, 2 / 3, 3 / 4, 1 / 6, 1 / 7, 1 / 8,
    2.0, 3.0, 4.0, 5.0, 10.0, 20.0, 1.5, 2.5,
]
RATIO_TOLERANCE = 0.05


def _closest_split_ratio(jump_ratio: float) -> Optional[float]:
    """Return the SPLIT_RATIOS entry closest to jump_ratio if within
    RATIO_TOLERANCE, else None."""
    best, best_err = None, RATIO_TOLERANCE
    for r in SPLIT_RATIOS:
        err = abs(jump_ratio - r) / r
        if err < best_err:
            best, best_err = r, err
    return best


def repair_instrument(conn, instrument_id, symbol, segment):
    """Repair a single instrument's OHLCV history in place.

    Two independent passes, both vendor-free (NSE bhavcopy stays the only
    price source):

    1. Corporate-action cliffs: if a day-to-day jump matches a clean
       split/bonus ratio, rescale every row strictly before that date by
       the same ratio so the whole series sits on one consistent basis.
    2. Isolated glitches: a single day whose close is way off both its
       immediate DB neighbors, and that doesn't fit a split ratio, is a
       data error (bad bhavcopy row, stale ETF tick, etc.) — delete it
       rather than guess a replacement value. Weekend rows are deleted
       outright since NSE never trades on Sat/Sun.
    """
    cursor = conn.cursor()

    if segment == "IND":
        logger.info(f"Skipping index {symbol} (ID: {instrument_id}) — equities only for now.")
        return False

    cursor.execute(
        "SELECT time, open, high, low, close, volume FROM ohlcv_eod "
        "WHERE instrument_id = ? ORDER BY time ASC",
        (instrument_id,),
    )
    rows = cursor.fetchall()
    if len(rows) < 2:
        return False

    rescaled_count = 0
    deleted_count = 0
    deletes = []

    # ── Pass 1: detect a split/bonus and rescale everything before it ──
    for i in range(1, len(rows)):
        prev_time, _, _, _, prev_close, _ = rows[i - 1]
        curr_time, _, _, _, curr_close, _ = rows[i]
        if not prev_close or prev_close <= 0 or not curr_close or curr_close <= 0:
            continue

        jump_ratio = curr_close / prev_close
        if 0.7 <= jump_ratio <= 1.3:
            continue  # ordinary day, no cliff to investigate

        ratio = _closest_split_ratio(jump_ratio)
        if ratio is None:
            continue  # big move but not a clean corporate-action fraction

        logger.info(
            f"{symbol}: detected likely split/bonus around {curr_time} "
            f"(price jump x{jump_ratio:.3f} ~= clean ratio {ratio:.3f}); "
            f"rescaling {i} prior rows by {ratio:.4f}."
        )
        cursor.execute(
            """
            UPDATE ohlcv_eod
            SET open = open * ?, high = high * ?, low = low * ?, close = close * ?,
                volume = CAST(volume / ? AS INTEGER)
            WHERE instrument_id = ? AND time < ?
            """,
            (ratio, ratio, ratio, ratio, ratio, instrument_id, curr_time),
        )
        rescaled_count += max(cursor.rowcount, 0)
        # Re-read rows so any further jumps in this same pass are evaluated
        # against the now-rescaled prices, not the stale pre-rescale ones.
        cursor.execute(
            "SELECT time, open, high, low, close, volume FROM ohlcv_eod "
            "WHERE instrument_id = ? ORDER BY time ASC",
            (instrument_id,),
        )
        rows = cursor.fetchall()

    # ── Pass 2: weekend rows + isolated single-day glitches ──
    # Weekend rows are dropped first and excluded from the neighbor-average
    # check below — comparing a weekday row against a bogus Saturday spike
    # as its "neighbor" would falsely flag the weekday row too.
    weekday_rows = []
    for row in rows:
        dt_str = row[0]
        dt_obj = datetime.strptime(dt_str.split(" ")[0], "%Y-%m-%d").date()
        if dt_obj.weekday() in (5, 6):
            deletes.append((instrument_id, dt_str))
            deleted_count += 1
        else:
            weekday_rows.append(row)

    WINDOW = 2  # bars on each side used as the reference window

    for i in range(len(weekday_rows)):
        dt_str, _, _, _, close, _ = weekday_rows[i]

        if not close or close <= 0:
            continue

        lo, hi = max(0, i - WINDOW), min(len(weekday_rows), i + WINDOW + 1)
        ref_closes = [
            weekday_rows[j][4] for j in range(lo, hi)
            if j != i and weekday_rows[j][4] and weekday_rows[j][4] > 0
        ]
        if len(ref_closes) < 2:
            continue

        # Median, not mean of immediate neighbors: robust to the glitch
        # itself sitting right next to another bar we're also evaluating.
        ref_closes.sort()
        mid = len(ref_closes) // 2
        median_ref = (
            ref_closes[mid] if len(ref_closes) % 2
            else (ref_closes[mid - 1] + ref_closes[mid]) / 2
        )

        if close > 1.3 * median_ref or close < 0.7 * median_ref:
            # Already explained by a detected split boundary? Pass 1 would
            # have rescaled it away, so anything still this far off here is
            # an unexplained glitch, not a corporate action. Check the jump
            # against the immediate (not windowed) neighbors specifically,
            # since that's where a real split boundary would show up.
            prev_close = weekday_rows[i - 1][4] if i > 0 else None
            next_close = weekday_rows[i + 1][4] if i < len(weekday_rows) - 1 else None
            jump_in = close / prev_close if prev_close else None
            jump_out = next_close / close if next_close and close > 0 else None
            ratio_in = _closest_split_ratio(jump_in) if jump_in else None
            ratio_out = _closest_split_ratio(jump_out) if jump_out else None
            if ratio_in is None and ratio_out is None:
                deletes.append((instrument_id, dt_str))
                deleted_count += 1

    if deletes:
        cursor.executemany(
            "DELETE FROM ohlcv_eod WHERE instrument_id = ? AND time = ?",
            deletes,
        )

    conn.commit()

    if rescaled_count > 0 or deleted_count > 0:
        logger.info(
            f"Repaired {symbol}: rescaled history at {rescaled_count} pre-split rows, "
            f"deleted {deleted_count} weekend/glitched rows."
        )
        return True

    logger.info(f"Instrument {symbol} is already clean.")
    return False


def clean_non_positive_prices(conn):
    """Floor any non-positive prices (<= 0) to 0.01 as a basic sanity check."""
    cursor = conn.cursor()
    cursor.execute("""
        SELECT COUNT(*) FROM ohlcv_eod
        WHERE open <= 0 OR high <= 0 OR low <= 0 OR close <= 0
    """)
    count = cursor.fetchone()[0]
    if count > 0:
        logger.info(f"Flooring {count} records with price <= 0 to 0.01...")
        cursor.execute("""
            UPDATE ohlcv_eod
            SET open = CASE WHEN open <= 0 THEN 0.01 ELSE open END,
                high = CASE WHEN high <= 0 THEN 0.01 ELSE high END,
                low = CASE WHEN low <= 0 THEN 0.01 ELSE low END,
                close = CASE WHEN close <= 0 THEN 0.01 ELSE close END
            WHERE open <= 0 OR high <= 0 OR low <= 0 OR close <= 0
        """)
        conn.commit()
        logger.info("Non-positive prices cleaned.")


def main():
    logger.info("🚀 Starting Advanced Price Spike and Corporate Action Cleanup...")
    
    if DB_URL.startswith("sqlite"):
        db_path = DB_URL.replace("sqlite:///", "").replace("sqlite://", "")
        if "?" in db_path:
            db_path = db_path.split("?")[0]
        if not os.path.exists(db_path):
            logger.error(f"Database not found at {db_path}")
            sys.exit(1)


        
    conn = get_db_connection()
    
    try:
        # 1. Clean non-positive prices
        clean_non_positive_prices(conn)
        
        # 2. Find all instruments with anomalies
        logger.info("Scanning database for price spikes, cliffs, and Saturday records...")
        suspects = find_suspect_instruments(conn)
        logger.info(f"Found {len(suspects)} instruments with anomalies in the database.")
        
        repaired_total = 0
        
        # 3. Repair each suspect instrument
        for i, (iid, symbol, segment) in enumerate(suspects):
            logger.info(f"[{i+1}/{len(suspects)}] Processing {symbol} (ID: {iid}, Segment: {segment})...")
            success = repair_instrument(conn, iid, symbol, segment)
            if success:
                repaired_total += 1
                
        logger.info("=" * 60)
        logger.info(f"✅ Advanced Cleanup Finished! Repaired a total of {repaired_total} instruments.")
        logger.info("=" * 60)
        
    finally:
        conn.close()


if __name__ == "__main__":
    main()
