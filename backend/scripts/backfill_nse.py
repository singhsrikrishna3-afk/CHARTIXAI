"""PEESTOCK — NSE Data Backfill Script.

Downloads and ingests historical bhavcopies for a date range.
"""

import os
import sys
import logging
from datetime import date, timedelta, datetime
import time

# Add backend to path
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from app.workers.tasks_eod import ingest_eod_data

logging.basicConfig(level=logging.INFO, format="%(asctime)s — %(message)s")
logger = logging.getLogger(__name__)

def backfill(start_date: date, end_date: date):
    """Iterate through dates and trigger ingestion."""
    current = start_date
    success_count = 0
    fail_count = 0
    
    logger.info(f"🚀 Starting backfill from {start_date} to {end_date}")
    
    while current <= end_date:
        # NSE Bhavcopy is only available for weekdays (Mon-Fri)
        if current.weekday() < 5:
            date_str = current.strftime("%Y-%m-%d")
            logger.info(f"📅 Processing {date_str}...")
            
            try:
                # Use the existing task logic
                # Note: ingest_eod_data is a Celery task, we call it directly here
                result = ingest_eod_data(date_str)
                if result.get("status") == "ok":
                    logger.info(f"  ✅ Ingested {result.get('records')} records.")
                    success_count += 1
                else:
                    logger.warning(f"  ⚠️ No data or failed for {date_str}: {result.get('status')}")
                    fail_count += 1
            except Exception as e:
                logger.error(f"  ❌ Error on {date_str}: {e}")
                fail_count += 1
            
            # Sleep to avoid hitting NSE rate limits
            time.sleep(1.5)
        else:
            logger.info(f"😴 Skipping {current} (Weekend)")
            
        current += timedelta(days=1)
    
    logger.info("=" * 60)
    logger.info(f"Backfill Complete: {success_count} days success, {fail_count} days failed/no data")
    logger.info("=" * 60)

if __name__ == "__main__":
    # Default: last 7 days
    end = date.today()
    start = end - timedelta(days=7)
    
    if len(sys.argv) > 2:
        start = datetime.strptime(sys.argv[1], "%Y-%m-%d").date()
        end = datetime.strptime(sys.argv[2], "%Y-%m-%d").date()
    
    # Run backfill
    backfill(start, end)
