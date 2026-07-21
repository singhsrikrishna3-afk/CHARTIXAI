"""Backfill the fundamentals table from Yahoo Finance.

Usage (from backend/):
  ./venv/bin/python -m scripts.backfill_fundamentals 50     # top 50 by traded value
  ./venv/bin/python -m scripts.backfill_fundamentals all    # full EQ universe (~25-40 min)
"""
import sys
import logging

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")

from app.services.fundamentals_ingest import run_sync  # noqa: E402

if __name__ == "__main__":
    arg = sys.argv[1] if len(sys.argv) > 1 else "50"
    limit = None if arg == "all" else int(arg)
    print(f"Backfilling fundamentals (limit={limit or 'ALL'})...")
    result = run_sync(limit=limit)
    print(result)
