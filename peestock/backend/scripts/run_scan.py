"""PEESTOCK — Manual Scan Trigger.

Runs pattern and trendline scans directly on the database.
"""

import os
import sys
import logging

# Add backend to path
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from app.workers.tasks_eod import run_pattern_scan, run_trendline_scan

logging.basicConfig(level=logging.INFO, format="%(asctime)s — %(message)s")
logger = logging.getLogger(__name__)

def main():
    logger.info("🚀 Triggering pattern scan...")
    # Run synchronously for this manual trigger
    res_patterns = run_pattern_scan()
    logger.info(f"✅ Pattern scan complete: {res_patterns}")
    
    logger.info("🚀 Triggering trendline scan...")
    res_trendlines = run_trendline_scan()
    logger.info(f"✅ Trendline scan complete: {res_trendlines}")

if __name__ == "__main__":
    main()
