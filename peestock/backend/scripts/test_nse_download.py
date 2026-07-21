"""PEESTOCK — Test NSE Bhavcopy Download.
"""

import os
import sys
import logging
from datetime import date

# Add backend to path
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from app.workers.tasks_eod import _download_bhavcopy

logging.basicConfig(level=logging.INFO, format="%(asctime)s — %(message)s")
logger = logging.getLogger(__name__)

def main():
    # Try to download for a recent date (e.g., last Friday if today is Sunday/Monday)
    # Today is 2026-05-11 (Monday). 2026-05-08 was Friday.
    test_date = date(2024, 5, 3)
    
    logger.info(f"🚀 Testing bhavcopy download for {test_date}...")
    df = _download_bhavcopy(test_date)
    
    if df is not None and not df.empty:
        logger.info(f"✅ Success! Downloaded {len(df)} records.")
        logger.info(f"Sample data:\n{df.head()}")
    else:
        logger.error("❌ Failed to download bhavcopy.")

if __name__ == "__main__":
    main()
