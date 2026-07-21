"""PEESTOCK — Local DB Initialization.

Creates database tables in the configured DATABASE_URL.
"""

import os
import sys
import logging
from sqlalchemy import create_engine

# Add backend to path
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from app.models.models import Base, Instrument, OhlcvEod, OhlcvIntraday, OhlcvResampled, User, Subscription, DetectedPattern, CustomScanner, Trendline

logging.basicConfig(level=logging.INFO, format="%(asctime)s — %(message)s")
logger = logging.getLogger(__name__)

def main():
    db_url = os.environ.get("DATABASE_URL", "sqlite:///peestock.db")
    if "+asyncpg" in db_url:
        db_url = db_url.replace("+asyncpg", "")
    
    logger.info(f"🚀 Initializing database at {db_url}...")
    engine = create_engine(db_url)
    
    # Create tables
    Base.metadata.create_all(engine)
    logger.info("✅ Database tables created successfully.")

if __name__ == "__main__":
    main()
