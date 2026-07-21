"""Regression test: run_pattern_scan must keep stable ids for patterns that
are redetected across scans, insert new rows for genuinely new patterns,
and delete rows for patterns that are no longer detected.

This guards against the bug where every scan did
DELETE FROM detected_patterns WHERE instrument_id=... + reinsert-everything,
which handed out a new id to every pattern on every run and broke any
chart deep-link (?pattern=<id>) the moment the next scan fired.

Run directly: python test_pattern_scan_upsert.py
"""

import os
import tempfile
from datetime import datetime
from unittest.mock import patch

import pandas as pd
from sqlalchemy import create_engine, text

from app.services.pattern_engine import DetectedPatternResult, PatternType, PivotPoint
import app.workers.tasks_eod as tasks_eod

SCHEMA = """
CREATE TABLE instruments (
    id INTEGER NOT NULL PRIMARY KEY,
    symbol VARCHAR(20) NOT NULL,
    name VARCHAR(200) NOT NULL,
    is_active BOOLEAN,
    created_at DATETIME
);
CREATE TABLE ohlcv_eod (
    time DATE NOT NULL,
    instrument_id INTEGER NOT NULL,
    open NUMERIC(12,2),
    high NUMERIC(12,2),
    low NUMERIC(12,2),
    close NUMERIC(12,2),
    volume BIGINT,
    PRIMARY KEY (time, instrument_id)
);
CREATE TABLE detected_patterns (
    id INTEGER NOT NULL PRIMARY KEY,
    instrument_id INTEGER NOT NULL,
    timeframe VARCHAR(5) NOT NULL,
    pattern_type VARCHAR(50) NOT NULL,
    status VARCHAR(20),
    confidence NUMERIC(5,2),
    detection_time DATETIME,
    key_points JSON,
    target_price NUMERIC(12,2),
    stop_loss NUMERIC(12,2),
    image_url TEXT,
    created_at DATETIME
);
"""


def pivot(day, price, is_high):
    return PivotPoint(index=day, price=price, time=pd.Timestamp(2026, 1, day), is_high=is_high)


def make_pattern(ptype, days_prices, status="forming"):
    pivots = [pivot(d, p, p_is_high) for d, p, p_is_high in days_prices]
    return DetectedPatternResult(
        pattern_type=ptype, confidence=0.8, pivots=pivots,
        target_price=None, stop_loss=None, status=status,
    )


def setup_db(tmp_path, instr_id=1):
    engine = create_engine(f"sqlite:///{tmp_path}")
    with engine.begin() as conn:
        for stmt in SCHEMA.strip().split(";"):
            if stmt.strip():
                conn.execute(text(stmt))
        conn.execute(
            text("INSERT INTO instruments (id, symbol, name, is_active, created_at) "
                 "VALUES (:id, 'TEST', 'Test Co', 1, :now)"),
            {"id": instr_id, "now": datetime.utcnow()},
        )
        # Noise row for an unrelated instrument that the scan never touches.
        # Production's detected_patterns table is shared across every instrument,
        # so it's never empty; without this, deleting all of *this* instrument's
        # rows would empty the whole table and SQLite would silently reuse id=1
        # on the next insert, masking the exact bug this test exists to catch.
        conn.execute(
            text("INSERT INTO instruments (id, symbol, name, is_active, created_at) "
                 "VALUES (999, 'NOISE', 'Noise Co', 1, :now)"),
            {"now": datetime.utcnow()},
        )
        conn.execute(
            text("INSERT INTO detected_patterns (instrument_id, timeframe, pattern_type, status, "
                 "detection_time, key_points) VALUES (999, 'D', 'noise', 'forming', :now, '{}')"),
            {"now": datetime.utcnow()},
        )
        for i in range(40):
            conn.execute(
                text("INSERT INTO ohlcv_eod (time, instrument_id, open, high, low, close, volume) "
                     "VALUES (:t, :iid, 100, 105, 95, 100, 1000)"),
                {"t": f"2026-01-{i+1:02d}" if i < 31 else f"2026-02-{i-30:02d}", "iid": instr_id},
            )
    return engine


def bump_id_counter(engine, n=5):
    # Simulate other instruments' scans inserting rows in between, the way
    # they really would inside the shared detected_patterns table — so the
    # global id high-water mark keeps climbing between our two scan runs,
    # the same as it does in production.
    with engine.begin() as conn:
        for _ in range(n):
            conn.execute(
                text("INSERT INTO detected_patterns (instrument_id, timeframe, pattern_type, status, "
                     "detection_time, key_points) VALUES (999, 'D', 'noise', 'forming', :now, '{}')"),
                {"now": datetime.utcnow()},
            )


def fetch_patterns(engine, instr_id=1):
    with engine.connect() as conn:
        rows = conn.execute(
            text("SELECT id, pattern_type, status FROM detected_patterns WHERE instrument_id=:iid ORDER BY id"),
            {"iid": instr_id},
        ).fetchall()
    return {(r[1]): r for r in rows}  # keyed by pattern_type for convenience


def run_with_canned_patterns(engine, instr_id, patterns):
    with patch.object(tasks_eod, "_get_sync_engine", return_value=engine), \
         patch("app.services.pattern_engine.PatternEngine.detect_all", return_value=patterns), \
         patch("app.services.pattern_engine.PatternEngine._find_pivots", return_value=[]):
        tasks_eod.run_pattern_scan(instr_id)


def main():
    fd, tmp_path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    os.remove(tmp_path)  # let sqlite create it fresh
    failures = []

    try:
        engine = setup_db(tmp_path)

        double_top = make_pattern(PatternType.DOUBLE_TOP, [(1, 110, True), (10, 111, True)])
        triple_bottom = make_pattern(PatternType.TRIPLE_BOTTOM, [(2, 90, False), (5, 91, False), (8, 90, False)])

        run_with_canned_patterns(engine, 1, [double_top, triple_bottom])
        run1 = fetch_patterns(engine)
        if set(run1.keys()) != {"double_top", "triple_bottom"}:
            failures.append(f"run1: expected double_top+triple_bottom, got {set(run1.keys())}")
        id_double_top_run1 = run1["double_top"][0]

        bump_id_counter(engine)

        # Run 2: double_top redetected unchanged (same pivots, now "completed"),
        # triple_bottom no longer detected, rectangle is new.
        double_top_v2 = make_pattern(PatternType.DOUBLE_TOP, [(1, 110, True), (10, 111, True)], status="completed")
        rectangle = make_pattern(PatternType.RECTANGLE, [(15, 100, True), (20, 100, False)])

        run_with_canned_patterns(engine, 1, [double_top_v2, rectangle])
        run2 = fetch_patterns(engine)

        if "triple_bottom" in run2:
            failures.append("run2: triple_bottom should have been deleted (no longer detected) but is still present")
        if "rectangle" not in run2:
            failures.append("run2: rectangle should have been inserted as a new pattern")
        if "double_top" not in run2:
            failures.append("run2: double_top should still be present")
        else:
            id_double_top_run2, _, status_run2 = run2["double_top"]
            if id_double_top_run2 != id_double_top_run1:
                failures.append(
                    f"run2: double_top id changed ({id_double_top_run1} -> {id_double_top_run2}) "
                    "— deep links to this pattern would now 404"
                )
            if status_run2 != "completed":
                failures.append(f"run2: double_top status should have updated to 'completed', got {status_run2!r}")
    finally:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)

    if failures:
        print("FAILED:")
        for f in failures:
            print(f"  - {f}")
        raise SystemExit(1)

    print("OK: pattern ids stable across rescans; stale patterns dropped; new patterns inserted.")


if __name__ == "__main__":
    main()
