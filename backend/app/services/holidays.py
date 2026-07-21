"""PEESTOCK — NSE Holidays service."""

import logging
from datetime import datetime, date
import requests
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from app.models.models import NseHoliday

logger = logging.getLogger(__name__)

# Official 2026 trading holidays list as a robust offline fallback
CURATED_2026_HOLIDAYS = [
    {"date": "2026-01-26", "day": "Monday", "description": "Republic Day"},
    {"date": "2026-02-15", "day": "Sunday", "description": "Mahashivratri (Weekend)"},
    {"date": "2026-03-03", "day": "Tuesday", "description": "Holi"},
    {"date": "2026-03-21", "day": "Saturday", "description": "Id-Ul-Fitr / Ramadan Eid (Weekend)"},
    {"date": "2026-03-26", "day": "Thursday", "description": "Shri Ram Navami"},
    {"date": "2026-03-31", "day": "Tuesday", "description": "Shri Mahavir Jayanti"},
    {"date": "2026-04-03", "day": "Friday", "description": "Good Friday"},
    {"date": "2026-04-14", "day": "Tuesday", "description": "Dr. Baba Saheb Ambedkar Jayanti"},
    {"date": "2026-05-01", "day": "Friday", "description": "Maharashtra Day"},
    {"date": "2026-05-28", "day": "Thursday", "description": "Bakri Id"},
    {"date": "2026-06-26", "day": "Friday", "description": "Muharram"},
    {"date": "2026-08-15", "day": "Saturday", "description": "Independence Day (Weekend)"},
    {"date": "2026-09-14", "day": "Monday", "description": "Ganesh Chaturthi"},
    {"date": "2026-10-02", "day": "Friday", "description": "Mahatma Gandhi Jayanti"},
    {"date": "2026-10-20", "day": "Tuesday", "description": "Dussehra"},
    {"date": "2026-11-08", "day": "Sunday", "description": "Diwali Laxmi Pujan (Muhurat Trading)"},
    {"date": "2026-11-10", "day": "Tuesday", "description": "Diwali-Balipratipada"},
    {"date": "2026-11-24", "day": "Tuesday", "description": "Prakash Gurpurb Sri Guru Nanak Dev"},
    {"date": "2026-12-25", "day": "Friday", "description": "Christmas"},
]


def fetch_nse_holidays_raw() -> list[dict]:
    """Fetch the holiday list directly from the official NSE India API.

    Uses a requests Session to handle cookies to bypass basic Cloudflare block.
    """
    url_main = "https://www.nseindia.com"
    url_api = "https://www.nseindia.com/api/holiday-master?type=trading"

    headers = {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": "https://www.nseindia.com/",
    }

    session = requests.Session()
    session.headers.update(headers)

    # Step 1: Hit main page to establish cookies
    logger.info("Visiting NSE India home page to set session cookies...")
    r_main = session.get(url_main, timeout=10)
    r_main.raise_for_status()

    # Step 2: Hit API endpoint with cookies
    logger.info("Fetching NSE holidays API...")
    r_api = session.get(url_api, timeout=10)
    r_api.raise_for_status()

    data = r_api.json()
    # The response is a dictionary containing holiday lists for various segments, e.g. "CM" (Capital Market)
    if not isinstance(data, dict) or "CM" not in data:
        raise ValueError("Invalid response structure from NSE API")

    cm_holidays = data["CM"]
    parsed_holidays = []
    for item in cm_holidays:
        # Expected structure: {"tradingDate": "26-Jan-2026", "weekDay": "Monday", "description": "Republic Day"}
        date_str = item.get("tradingDate")
        day_str = item.get("weekDay", "")
        desc = item.get("description", "")

        if not date_str or not desc:
            continue

        try:
            # Parse '26-Jan-2026'
            parsed_date = datetime.strptime(date_str, "%d-%b-%Y").date()
            parsed_holidays.append({
                "date": parsed_date.isoformat(),
                "day": day_str,
                "description": desc
            })
        except Exception as e:
            logger.warning("Failed to parse date %s: %s", date_str, e)

    return parsed_holidays


async def sync_nse_holidays(db: AsyncSession, force_download: bool = False) -> tuple[int, str]:
    """Downloads holidays from NSE API and stores them in the database.

    If the download fails, falls back to the curated 2026 list.
    Returns: (count, source)
    """
    downloaded = []
    source = "live_nse_api"

    if force_download:
        try:
            downloaded = fetch_nse_holidays_raw()
            logger.info("Successfully downloaded %d holidays from NSE API", len(downloaded))
        except Exception as e:
            logger.error("Failed to download holidays from live NSE API: %s. Falling back to curated list.", e)
            downloaded = []

    if not downloaded:
        logger.info("Using curated offline fallback list for 2026 holidays.")
        downloaded = CURATED_2026_HOLIDAYS
        source = "curated_fallback"

    # Upsert into database
    count = 0
    for h in downloaded:
        h_date = date.fromisoformat(h["date"])
        h_day = h["day"]
        h_desc = h["description"]

        # Check if already exists
        q = select(NseHoliday).where(NseHoliday.trading_date == h_date)
        res = await db.execute(q)
        existing = res.scalar_one_or_none()

        if existing:
            existing.week_day = h_day
            existing.description = h_desc
        else:
            new_h = NseHoliday(
                trading_date=h_date,
                week_day=h_day,
                description=h_desc,
                holiday_type="trading"
            )
            db.add(new_h)
        count += 1

    await db.commit()
    return count, source


async def get_all_holidays(db: AsyncSession) -> list[NseHoliday]:
    """Retrieve all holidays sorted by date."""
    q = select(NseHoliday).order_by(NseHoliday.trading_date)
    res = await db.execute(q)
    return list(res.scalars().all())
