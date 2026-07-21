"""PEESTOCK — Seed index constituents many-to-many table."""

import os
import sys
import csv
import io
import logging
import requests
from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session

# Add backend to path
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from app.config import get_settings
from app.models.models import Base, Instrument, IndexConstituent

logging.basicConfig(level=logging.INFO, format="%(asctime)s — %(levelname)s — %(message)s")
logger = logging.getLogger(__name__)

settings = get_settings()
SYNC_DB_URL = settings.DATABASE_URL.replace("+asyncpg", "").replace(
    "+aiosqlite", ""
).replace("postgresql+psycopg2", "postgresql")

INDEX_METADATA = {
    "Nifty 50": {"symbol": "NIFTY_50", "name": "Nifty 50"},
    "Nifty Auto": {"symbol": "NIFTY_AUTO", "name": "Nifty Auto"},
    "Nifty Bank": {"symbol": "NIFTY_BANK", "name": "Nifty Bank"},
    "Nifty Cement": {"symbol": "NIFTY_CEMENT", "name": "Nifty Cement"},
    "Nifty Chemicals": {"symbol": "NIFTY_CHEMICALS", "name": "Nifty Chemicals"},
    "Nifty Financial Services": {"symbol": "NIFTY_FIN_SERVICES", "name": "Nifty Financial Services"},
    "Nifty Financial Services 25/50": {"symbol": "NIFTY_FIN_SERVICES_25_50", "name": "Nifty Financial Services 25/50"},
    "Nifty Financial Services Ex-Bank": {"symbol": "NIFTY_FIN_SERVICES_EX_BANK", "name": "Nifty Financial Services Ex-Bank"},
    "Nifty FMCG": {"symbol": "NIFTY_FMCG", "name": "Nifty FMCG"},
    "Nifty Healthcare Index": {"symbol": "NIFTY_HEALTHCARE", "name": "Nifty Healthcare Index"},
    "Nifty IT": {"symbol": "NIFTY_IT", "name": "Nifty IT"},
    "Nifty Media": {"symbol": "NIFTY_MEDIA", "name": "Nifty Media"},
    "Nifty Metal": {"symbol": "NIFTY_METAL", "name": "Nifty Metal"},
    "Nifty Pharma": {"symbol": "NIFTY_PHARMA", "name": "Nifty Pharma"},
    "Nifty Private Bank": {"symbol": "NIFTY_PRIVATE_BANK", "name": "Nifty Private Bank"},
    "Nifty PSU Bank": {"symbol": "NIFTY_PSU_BANK", "name": "Nifty PSU Bank"},
    "Nifty Realty": {"symbol": "NIFTY_REALTY", "name": "Nifty Realty"},
    "Nifty REITs & Realty": {"symbol": "NIFTY_REITS_REALTY", "name": "Nifty REITs & Realty"},
    "Nifty Consumer Durables": {"symbol": "NIFTY_CONSUMER_DURABLES", "name": "Nifty Consumer Durables"},
    "Nifty Oil & Gas": {"symbol": "NIFTY_OIL_GAS", "name": "Nifty Oil & Gas"},
    "Nifty500 Healthcare": {"symbol": "NIFTY_500_HEALTHCARE", "name": "Nifty500 Healthcare"},
    "Nifty MidSmall Financial Services": {"symbol": "NIFTY_MIDSMALL_FIN_SERVICES", "name": "Nifty MidSmall Financial Services"},
    "Nifty MidSmall Healthcare": {"symbol": "NIFTY_MIDSMALL_HEALTHCARE", "name": "Nifty MidSmall Healthcare"},
    "Nifty MidSmall IT & Telecom": {"symbol": "NIFTY_MIDSMALL_IT_TELECOM", "name": "Nifty MidSmall IT & Telecom"},
}

INDEX_LISTS = {
    "Nifty 50": "https://archives.nseindia.com/content/indices/ind_nifty50list.csv",
    "Nifty Auto": "https://archives.nseindia.com/content/indices/ind_niftyautolist.csv",
    "Nifty Bank": "https://archives.nseindia.com/content/indices/ind_niftybanklist.csv",
    "Nifty Cement": "https://www.niftyindices.com/IndexConstituent/ind_niftycement_list.csv",
    "Nifty Chemicals": "https://www.niftyindices.com/IndexConstituent/ind_niftychemicals_list.csv",
    "Nifty Financial Services": "https://archives.nseindia.com/content/indices/ind_niftyfinancelist.csv",
    "Nifty Financial Services 25/50": "https://archives.nseindia.com/content/indices/ind_niftyfinancialservices25_50list.csv",
    "Nifty Financial Services Ex-Bank": "https://archives.nseindia.com/content/indices/ind_niftyfinancialservicesexbank_list.csv",
    "Nifty FMCG": "https://archives.nseindia.com/content/indices/ind_niftyfmcglist.csv",
    "Nifty Healthcare Index": "https://archives.nseindia.com/content/indices/ind_niftyhealthcarelist.csv",
    "Nifty IT": "https://archives.nseindia.com/content/indices/ind_niftyitlist.csv",
    "Nifty Media": "https://archives.nseindia.com/content/indices/ind_niftymedialist.csv",
    "Nifty Metal": "https://archives.nseindia.com/content/indices/ind_niftymetallist.csv",
    "Nifty Pharma": "https://archives.nseindia.com/content/indices/ind_niftypharmalist.csv",
    "Nifty Private Bank": "https://archives.nseindia.com/content/indices/ind_nifty_privatebanklist.csv",
    "Nifty PSU Bank": "https://archives.nseindia.com/content/indices/ind_niftypsubanklist.csv",
    "Nifty Realty": "https://archives.nseindia.com/content/indices/ind_niftyrealtylist.csv",
    "Nifty REITs & Realty": "https://www.niftyindices.com/IndexConstituent/ind_niftyreitsrealty_list.csv",
    "Nifty Consumer Durables": "https://archives.nseindia.com/content/indices/ind_niftyconsumerdurableslist.csv",
    "Nifty Oil & Gas": "https://archives.nseindia.com/content/indices/ind_niftyoilgaslist.csv",
    "Nifty500 Healthcare": "https://www.niftyindices.com/IndexConstituent/ind_nifty500healthcare_list.csv",
    "Nifty MidSmall Financial Services": "https://www.niftyindices.com/IndexConstituent/ind_niftymidsmallfinancailservice_list.csv",
    "Nifty MidSmall Healthcare": "https://archives.nseindia.com/content/indices/ind_niftymidsmallhealthcare_list.csv",
    "Nifty MidSmall IT & Telecom": "https://www.niftyindices.com/IndexConstituent/ind_niftymidsmallitandtelecom_list.csv",
}

FALLBACK_CONSTITUENTS = {
    "NIFTY_50": [
        "RELIANCE", "TCS", "HDFCBANK", "INFY", "ICICIBANK", "BAJAJ-AUTO", "ITC", "SBIN", "BHARTIARTL",
        "KOTAKBANK", "LT", "ASIANPAINT", "AXISBANK", "MARUTI", "SUNPHARMA", "BAJFINANCE", "TITAN",
        "ULTRACEMCO", "BAJAJFINSV", "TATASTEEL", "ADANIENT", "ADANIPORTS", "APOLLOHOSP", "BEL",
        "CIPLA", "COALINDIA", "DRREDDY", "EICHERMOT", "GRASIM", "HCLTECH", "HDFCLIFE", "HINDALCO",
        "HINDUNILVR", "INDIGO", "JSWSTEEL", "JIOFIN", "M&M", "MAXHEALTH", "NTPC", "NESTLEIND",
        "ONGC", "POWERGRID", "SBILIFE", "SHRIRAMFIN", "TATACONSUM", "TECHM", "TRENT", "WIPRO",
        "BPCL", "BRITANNIA"
    ],
    "NIFTY_BANK": [
        "HDFCBANK", "ICICIBANK", "SBIN", "AXISBANK", "KOTAKBANK", "INDUSINDBK", "BANKBARODA",
        "AUBANK", "FEDERALBNK", "IDFCFIRSTB", "PNB", "BANDHANBNK"
    ],
    "NIFTY_IT": [
        "TCS", "INFY", "HCLTECH", "WIPRO", "TECHM", "LTIM", "COFORGE", "MPHASIS", "PERSISTENT", "LTTS"
    ],
    "NIFTY_AUTO": [
        "MARUTI", "TATAMOTORS", "M&M", "BAJAJ-AUTO", "EICHERMOT", "HEROMOTOCO", "TVSMOTOR",
        "ASHOKLEY", "BOSCHLTD", "MRF", "BALKRISIND", "TIINDIA", "BHARATFORG", "EXIDEIND", "MOTHERSON"
    ],
}

NSE_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Accept": "*/*",
}

def get_engine():
    kwargs = {}
    if SYNC_DB_URL.startswith("sqlite"):
        kwargs["connect_args"] = {"timeout": 30}
    return create_engine(SYNC_DB_URL, pool_pre_ping=True, **kwargs)

def download_constituents(index_name: str, url: str):
    """Download constituent list CSV and extract symbols."""
    logger.info(f"Downloading constituents for {index_name} from {url}")
    try:
        resp = requests.get(url, headers=NSE_HEADERS, timeout=15)
        resp.raise_for_status()
        
        # Read CSV content
        f = io.StringIO(resp.text)
        reader = csv.DictReader(f)
        
        # Clean column names (strip whitespace)
        reader.fieldnames = [name.strip() for name in reader.fieldnames]
        
        symbols = []
        for row in reader:
            symbol_key = None
            for key in row.keys():
                if key.lower() in ("symbol", "symbol name"):
                    symbol_key = key
                    break
            
            if symbol_key and row[symbol_key]:
                symbol = row[symbol_key].strip()
                symbols.append(symbol)
                
        logger.info(f"Found {len(symbols)} constituents for {index_name} via download")
        return symbols
    except Exception as e:
        logger.error(f"Failed to download constituents for {index_name}: {e}")
        return []

def main():
    engine = get_engine()
    
    # Ensure the table is created
    logger.info("Ensuring index_constituents table exists...")
    Base.metadata.create_all(engine)
    
    with Session(engine) as session:
        # Load all instruments (both EQ and IND) to map symbols to IDs
        instruments = session.execute(
            text("SELECT id, symbol, segment FROM instruments WHERE is_active = 1")
        ).fetchall()
        
        symbol_to_id = {}
        index_symbol_to_id = {}
        
        for row in instruments:
            iid, symbol, segment = row
            if segment == 'IND':
                index_symbol_to_id[symbol] = iid
            else:
                symbol_to_id[symbol] = iid
                
        logger.info(f"Loaded {len(index_symbol_to_id)} index instruments and {len(symbol_to_id)} stock instruments from DB")

        # Clear existing constituents to allow clean re-runs
        logger.info("Clearing existing index constituents...")
        session.execute(text("DELETE FROM index_constituents"))
        session.commit()
        
        total_inserted = 0

        for index_name, meta in INDEX_METADATA.items():
            index_symbol = meta["symbol"]
            index_id = index_symbol_to_id.get(index_symbol)
            
            if not index_id:
                logger.warning(f"Index {index_symbol} ({index_name}) not found in database. Skipping constituents.")
                continue
                
            # Try downloading first
            url = INDEX_LISTS.get(index_name)
            const_symbols = download_constituents(index_name, url) if url else []
            
            # Fallback if download failed or returned empty
            if not const_symbols and index_symbol in FALLBACK_CONSTITUENTS:
                logger.info(f"Using local fallback constituents for {index_symbol}")
                const_symbols = FALLBACK_CONSTITUENTS[index_symbol]
                
            if not const_symbols:
                logger.warning(f"No constituents found for index {index_name}")
                continue
                
            records = []
            for sym in const_symbols:
                # Resolve stock ID
                stock_id = symbol_to_id.get(sym)
                if stock_id:
                    records.append({
                        "index_id": index_id,
                        "instrument_id": stock_id
                    })
                else:
                    # In case of minor symbol differences (e.g. BAJAJ-AUTO in DB vs BAJAJ_AUTO in list)
                    # Try to resolve case insensitively
                    found_id = None
                    for db_sym, db_id in symbol_to_id.items():
                        if db_sym.replace("-", "").replace("_", "").upper() == sym.replace("-", "").replace("_", "").upper():
                            found_id = db_id
                            break
                    if found_id:
                        records.append({
                            "index_id": index_id,
                            "instrument_id": found_id
                        })
                    else:
                        logger.debug(f"Constituent stock {sym} of index {index_name} not found in database instruments.")

            if records:
                # Insert
                session.execute(
                    text(
                        "INSERT OR IGNORE INTO index_constituents (index_id, instrument_id) "
                        "VALUES (:index_id, :instrument_id)"
                    ),
                    records
                )
                session.commit()
                logger.info(f"✅ Successfully mapped {len(records)} constituents for {index_name}")
                total_inserted += len(records)
                
        logger.info(f"🎉 Seeding complete! Mapped {total_inserted} index-constituent records in total.")

if __name__ == "__main__":
    main()
