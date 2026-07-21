"""PEESTOCK — Create and seed nse_holidays table."""

import os
import sys
import asyncio
import logging

# Add backend directory to path
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from sqlalchemy import create_engine
from app.models.models import Base
from app.database import AsyncSessionLocal
from app.services.holidays import sync_nse_holidays

logging.basicConfig(level=logging.INFO, format="%(asctime)s — %(levelname)s — %(message)s")
logger = logging.getLogger(__name__)


async def main():
    # Detect DB path
    from app.config import get_settings
    settings = get_settings()
    db_url = settings.DATABASE_URL
    
    # Clean DB url for synchronous create_engine
    sync_db_url = db_url
    if "+aiosqlite" in sync_db_url:
        sync_db_url = sync_db_url.replace("+aiosqlite", "")
    elif "sqlite" in sync_db_url and "aiosqlite" not in sync_db_url and "://" in sync_db_url:
        # It is already sync
        pass

    logger.info("🚀 Creating nse_holidays table...")
    try:
        engine = create_engine(sync_db_url)
        # Only create the nse_holidays table specifically
        Base.metadata.create_all(engine, tables=[Base.metadata.tables["nse_holidays"]])
        logger.info("✅ Table 'nse_holidays' created or verified successfully.")
    except Exception as e:
        logger.error("❌ Failed to create table: %s", e)
        sys.exit(1)

    # Seed the table using the holidays service
    logger.info("🌱 Seeding initial holidays...")
    try:
        async with AsyncSessionLocal() as session:
            # We seed with the fallback list initially to guarantee immediate data
            count, source = await sync_nse_holidays(session, force_download=False)
            logger.info("✅ Seeded %d holidays using source '%s'.", count, source)
    except Exception as e:
        logger.error("❌ Failed to seed holidays: %s", e)
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
