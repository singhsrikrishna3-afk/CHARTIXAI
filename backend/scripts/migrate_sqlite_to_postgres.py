"""PEESTOCK — SQLite → PostgreSQL one-shot data migration.

Run ONCE on the server after PostgreSQL is set up and the schema is created
via Alembic. Copies ALL data from the SQLite file to PostgreSQL in batches
using raw SQL (no ORM) for maximum speed.

Usage:
    SQLITE_PATH=/path/to/peestock.db \\
    DATABASE_URL=postgresql://peestock:password@localhost/peestock \\
    python scripts/migrate_sqlite_to_postgres.py

Safety:
  - Read-only on SQLite (never writes back).
  - Idempotent for tables that have UNIQUE constraints (uses INSERT ... ON CONFLICT DO NOTHING).
  - Large tables (ohlcv_eod, ohlcv_intraday) are streamed in BATCH_SIZE chunks to avoid OOM.
  - UUID columns: SQLite stores them as strings; this script casts them to uuid on insert.
"""
import os
import sys
import time
import sqlite3
import uuid

import psycopg2
import psycopg2.extras

SQLITE_PATH = os.environ.get(
    "SQLITE_PATH",
    os.path.normpath(os.path.join(os.path.dirname(__file__), "../../peestock.db"))
)
PG_URL = os.environ.get("DATABASE_URL", "")

BATCH_SIZE = 50_000  # rows per INSERT batch for large tables


def pg_connect():
    url = PG_URL
    # Strip asyncpg/aiosqlite driver prefix if present
    url = url.replace("postgresql+asyncpg://", "postgresql://")
    url = url.replace("postgresql+psycopg2://", "postgresql://")
    return psycopg2.connect(url)


def copy_table(sqlite_cur, pg_cur, table, columns, conflict_clause="ON CONFLICT DO NOTHING", batch=BATCH_SIZE):
    col_list = ", ".join(columns)
    placeholders = ", ".join(["%s"] * len(columns))
    insert_sql = f"INSERT INTO {table} ({col_list}) VALUES ({placeholders}) {conflict_clause}"

    sqlite_cur.execute(f"SELECT COUNT(*) FROM {table}")
    total = sqlite_cur.fetchone()[0]
    print(f"  [{table}] {total:,} rows ...", flush=True)
    if total == 0:
        return

    offset = 0
    copied = 0
    while True:
        sqlite_cur.execute(f"SELECT {col_list} FROM {table} LIMIT {batch} OFFSET {offset}")
        rows = sqlite_cur.fetchall()
        if not rows:
            break
        psycopg2.extras.execute_batch(pg_cur, insert_sql, rows, page_size=1000)
        copied += len(rows)
        offset += batch
        if total > batch:
            print(f"    {copied:,}/{total:,}", flush=True)

    print(f"  [{table}] done ({copied:,} rows)", flush=True)


def copy_uuid_table(sqlite_cur, pg_cur, table, columns, uuid_cols, conflict_clause="ON CONFLICT DO NOTHING"):
    """Same as copy_table but casts string UUID columns to actual UUID objects."""
    col_list = ", ".join(columns)
    placeholders = ", ".join(["%s"] * len(columns))
    insert_sql = f"INSERT INTO {table} ({col_list}) VALUES ({placeholders}) {conflict_clause}"

    sqlite_cur.execute(f"SELECT COUNT(*) FROM {table}")
    total = sqlite_cur.fetchone()[0]
    print(f"  [{table}] {total:,} rows ...", flush=True)
    if total == 0:
        return

    uuid_indices = [columns.index(c) for c in uuid_cols]

    sqlite_cur.execute(f"SELECT {col_list} FROM {table}")
    rows = sqlite_cur.fetchall()
    cast_rows = []
    for row in rows:
        row = list(row)
        for i in uuid_indices:
            if row[i] is not None:
                try:
                    row[i] = uuid.UUID(str(row[i]))
                except (ValueError, AttributeError):
                    row[i] = None
        cast_rows.append(tuple(row))

    psycopg2.extras.execute_batch(pg_cur, insert_sql, cast_rows, page_size=1000)
    print(f"  [{table}] done ({len(cast_rows):,} rows)", flush=True)


def main():
    if not PG_URL:
        print("ERROR: Set DATABASE_URL env var to the PostgreSQL connection string.", file=sys.stderr)
        sys.exit(1)
    if not os.path.exists(SQLITE_PATH):
        print(f"ERROR: SQLite file not found: {SQLITE_PATH}", file=sys.stderr)
        sys.exit(1)

    print(f"Source SQLite : {SQLITE_PATH}")
    print(f"Target Postgres: {PG_URL[:PG_URL.find('@') + 1]}***")
    print()

    t0 = time.time()
    sqlite_conn = sqlite3.connect(SQLITE_PATH)
    sqlite_conn.row_factory = None  # tuple rows
    sc = sqlite_conn.cursor()

    pg_conn = pg_connect()
    pg_conn.autocommit = False
    pc = pg_conn.cursor()

    try:
        # ── Plain integer-PK tables ──────────────────────────────────────────
        print("=== instruments ===")
        copy_table(sc, pc, "instruments", [
            "id", "symbol", "name", "exchange", "segment", "isin",
            "lot_size", "is_active", "is_intraday", "sector", "industry", "created_at",
        ])

        print("=== index_constituents ===")
        copy_table(sc, pc, "index_constituents", ["index_id", "instrument_id"])

        print("=== ohlcv_eod ===")
        copy_table(sc, pc, "ohlcv_eod", [
            "id", "instrument_id", "time", "open", "high", "low", "close", "volume",
        ], conflict_clause="ON CONFLICT (instrument_id, time) DO NOTHING")

        print("=== ohlcv_intraday ===")
        copy_table(sc, pc, "ohlcv_intraday", [
            "id", "instrument_id", "time", "open", "high", "low", "close", "volume",
        ], conflict_clause="ON CONFLICT (instrument_id, time) DO NOTHING")

        print("=== ohlcv_resampled ===")
        copy_table(sc, pc, "ohlcv_resampled", [
            "id", "instrument_id", "timeframe", "time", "open", "high", "low", "close", "volume",
        ])

        # ── UUID-PK tables ───────────────────────────────────────────────────
        print("=== users ===")
        copy_uuid_table(sc, pc, "users", [
            "id", "email", "hashed_password", "full_name", "is_active", "is_admin", "created_at",
        ], uuid_cols=["id"])

        print("=== subscriptions ===")
        copy_uuid_table(sc, pc, "subscriptions", [
            "id", "user_id", "tier", "status", "utr", "started_at", "expires_at", "created_at",
        ], uuid_cols=["id", "user_id"])

        # ── Remaining tables ─────────────────────────────────────────────────
        print("=== detected_patterns ===")
        copy_table(sc, pc, "detected_patterns", [
            "id", "instrument_id", "pattern_name", "timeframe", "detected_at",
            "start_time", "end_time", "direction", "confidence", "key_points", "is_active",
        ])

        print("=== pattern_backtest_stats ===")
        copy_table(sc, pc, "pattern_backtest_stats", [
            "id", "instrument_id", "pattern_name", "timeframe",
            "win_rate", "avg_gain_pct", "avg_loss_pct", "total_trades", "last_updated",
        ])

        print("=== custom_scanners ===")
        copy_uuid_table(sc, pc, "custom_scanners", [
            "id", "user_id", "name", "description", "conditions", "is_active", "created_at",
        ], uuid_cols=["user_id"])

        print("=== trendlines ===")
        copy_uuid_table(sc, pc, "trendlines", [
            "id", "user_id", "instrument_id", "timeframe",
            "x1", "y1", "x2", "y2", "color", "created_at",
        ], uuid_cols=["user_id"])

        print("=== watchlist_items ===")
        copy_uuid_table(sc, pc, "watchlist_items", [
            "id", "user_id", "instrument_id", "added_at",
        ], uuid_cols=["user_id"])

        print("=== portfolio_positions ===")
        copy_uuid_table(sc, pc, "portfolio_positions", [
            "id", "user_id", "instrument_id", "quantity", "avg_price", "created_at",
        ], uuid_cols=["user_id"])

        print("=== alert_rules ===")
        copy_uuid_table(sc, pc, "alert_rules", [
            "id", "user_id", "instrument_id", "condition_type", "threshold", "is_active", "created_at",
        ], uuid_cols=["user_id"])

        print("=== triggered_alerts ===")
        copy_uuid_table(sc, pc, "triggered_alerts", [
            "id", "user_id", "alert_rule_id", "instrument_id", "message", "triggered_at",
        ], uuid_cols=["user_id"])

        print("=== forecasts ===")
        copy_table(sc, pc, "forecasts", [
            "id", "instrument_id", "symbol", "model_version", "horizon_day",
            "anchor_date", "anchor_price", "predicted_price", "lower_bound", "upper_bound", "predicted_at",
        ], conflict_clause="ON CONFLICT (instrument_id, horizon_day) DO NOTHING")

        print("=== nse_holidays ===")
        copy_table(sc, pc, "nse_holidays", [
            "id", "date", "description", "exchange",
        ])

        # Reset all sequences so new INSERTs don't collide with copied IDs
        print("\nResetting PostgreSQL sequences ...", flush=True)
        int_pk_tables = [
            "instruments", "ohlcv_eod", "ohlcv_intraday", "ohlcv_resampled",
            "detected_patterns", "pattern_backtest_stats", "custom_scanners",
            "trendlines", "watchlist_items", "portfolio_positions",
            "alert_rules", "triggered_alerts", "forecasts", "nse_holidays",
        ]
        for tbl in int_pk_tables:
            pc.execute(f"""
                SELECT setval(
                    pg_get_serial_sequence('{tbl}', 'id'),
                    COALESCE(MAX(id), 1)
                ) FROM {tbl}
            """)
        print("Sequences reset.", flush=True)

        pg_conn.commit()
        print(f"\nMigration complete in {time.time() - t0:.0f}s", flush=True)

    except Exception as e:
        pg_conn.rollback()
        print(f"\nERROR — rolled back: {e}", file=sys.stderr)
        raise
    finally:
        sqlite_conn.close()
        pg_conn.close()


if __name__ == "__main__":
    main()
