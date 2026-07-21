"""PEESTOCK — Bulk Data Seed Script.

Loads historical NSE CSV files from the archive directory into
TimescaleDB (instruments + ohlcv_eod tables).

Usage:
    python -m backend.scripts.seed_archive /path/to/archive/

Or from within the backend container:
    python scripts/seed_archive.py /path/to/archive/
"""

import os
import sys
import glob
import logging
from pathlib import Path

import pandas as pd
from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session

logging.basicConfig(level=logging.INFO, format="%(asctime)s — %(message)s")
logger = logging.getLogger(__name__)

# ── Database URL ──────────────────────────────────────────────
# Reads from env; defaults to local docker-compose config
DATABASE_URL = os.environ.get(
    "DATABASE_URL",
    "postgresql://peestock:peestock_dev@localhost:5432/peestock",
)
# Strip async driver suffix if present
DATABASE_URL = DATABASE_URL.replace("+asyncpg", "").replace("+psycopg2", "")


def seed_archive(archive_dir: str):
    """Load all CSV files from archive_dir into the database."""
    archive_path = Path(archive_dir)
    csv_files = sorted(glob.glob(str(archive_path / "*.csv")))

    if not csv_files:
        logger.error(f"No CSV files found in {archive_dir}")
        sys.exit(1)

    logger.info(f"Found {len(csv_files)} CSV files in {archive_dir}")

    engine = create_engine(DATABASE_URL, pool_pre_ping=True)
    total_instruments = 0
    total_records = 0

    with Session(engine) as session:
        for csv_file in csv_files:
            filename = Path(csv_file).stem  # e.g. "BHARTIARTL"
            logger.info(f"Processing {filename}...")

            try:
                df = pd.read_csv(csv_file)
            except Exception as e:
                logger.warning(f"  ✗ Failed to read {csv_file}: {e}")
                continue

            # Normalize column names
            df.columns = [c.strip() for c in df.columns]

            # Validate required columns
            required = {"Date", "Open", "High", "Low", "Close", "Volume"}
            if not required.issubset(set(df.columns)):
                logger.warning(
                    f"  ✗ Missing columns in {filename}. "
                    f"Has: {list(df.columns)}, Need: {required}"
                )
                continue

            # Get symbol from CSV column or filename
            if "Symbol" in df.columns and len(df) > 0:
                symbol = df["Symbol"].iloc[-1].strip().upper()
            else:
                symbol = filename.upper()

            # Clean data
            df["Date"] = pd.to_datetime(df["Date"], errors="coerce")
            df = df.dropna(subset=["Date"])
            df = df.sort_values("Date").reset_index(drop=True)

            for col in ["Open", "High", "Low", "Close"]:
                df[col] = pd.to_numeric(df[col], errors="coerce")
            df["Volume"] = pd.to_numeric(df["Volume"], errors="coerce").fillna(0).astype(int)

            # Drop rows with NaN prices
            df = df.dropna(subset=["Open", "High", "Low", "Close"])

            if df.empty:
                logger.warning(f"  ✗ No valid data in {filename}")
                continue

            # Upsert instrument
            result = session.execute(
                text("SELECT id FROM instruments WHERE symbol = :sym"),
                {"sym": symbol},
            )
            instr = result.fetchone()

            if not instr:
                session.execute(
                    text(
                        "INSERT INTO instruments (symbol, name, exchange, segment, is_active, created_at) "
                        "VALUES (:sym, :name, 'NSE', 'EQ', 1, CURRENT_TIMESTAMP) "
                        "ON CONFLICT (symbol) DO NOTHING"
                    ),
                    {"sym": symbol, "name": symbol},
                )
                session.flush()
                result = session.execute(
                    text("SELECT id FROM instruments WHERE symbol = :sym"),
                    {"sym": symbol},
                )
                instr = result.fetchone()
                total_instruments += 1

            if not instr:
                logger.warning(f"  ✗ Could not create instrument for {symbol}")
                continue

            instrument_id = instr[0]

            # Batch upsert OHLCV data
            records = 0
            batch_size = 500
            for batch_start in range(0, len(df), batch_size):
                batch = df.iloc[batch_start : batch_start + batch_size]
                for _, row in batch.iterrows():
                    session.execute(
                        text(
                            "INSERT INTO ohlcv_eod "
                            "(time, instrument_id, open, high, low, close, volume) "
                            "VALUES (:t, :iid, :o, :h, :l, :c, :v) "
                            "ON CONFLICT (instrument_id, time) DO UPDATE SET "
                            "open=EXCLUDED.open, high=EXCLUDED.high, "
                            "low=EXCLUDED.low, close=EXCLUDED.close, "
                            "volume=EXCLUDED.volume"
                        ),
                        {
                            "t": row["Date"].date(),
                            "iid": instrument_id,
                            "o": float(row["Open"]),
                            "h": float(row["High"]),
                            "l": float(row["Low"]),
                            "c": float(row["Close"]),
                            "v": int(row["Volume"]),
                        },
                    )
                    records += 1
                session.flush()

            session.commit()
            total_records += records
            logger.info(f"  ✓ {symbol}: {records} records ({df['Date'].min().date()} → {df['Date'].max().date()})")

    logger.info("=" * 60)
    logger.info(f"Seed complete: {total_instruments} new instruments, {total_records} OHLCV records")
    logger.info("=" * 60)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        # Default to the known archive location
        archive = os.path.expanduser("~/AG1 BB/lstm2/archive")
        if not os.path.isdir(archive):
            print(f"Usage: python {sys.argv[0]} /path/to/archive/")
            print(f"Default path not found: {archive}")
            sys.exit(1)
    else:
        archive = sys.argv[1]

    seed_archive(archive)
