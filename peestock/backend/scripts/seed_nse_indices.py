"""PEESTOCK — Seed Nifty sectoral and thematic indices and their constituents."""

import asyncio
import csv
import io
import logging
import os
import sys
from datetime import date, datetime, timedelta
import requests
import pandas as pd
import yfinance as yf
from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session

# Add backend to path
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from app.config import get_settings
from app.models.models import Instrument, OhlcvEod

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
        
        # Clean column names (strip whitespace and lower/upper case changes)
        reader.fieldnames = [name.strip() for name in reader.fieldnames]
        
        symbols = []
        for row in reader:
            # Look for Symbol column
            symbol_key = None
            for key in row.keys():
                if key.lower() in ("symbol", "symbol name"):
                    symbol_key = key
                    break
            
            if symbol_key and row[symbol_key]:
                symbol = row[symbol_key].strip()
                company_name = row.get("Company Name", symbol).strip()
                isin = row.get("ISIN Code", "").strip()
                symbols.append({"symbol": symbol, "name": company_name, "isin": isin})
                
        logger.info(f"Found {len(symbols)} constituents for {index_name}")
        return symbols
    except Exception as e:
        logger.error(f"Failed to download constituents for {index_name}: {e}")
        return []

async def download_index_eod_day(client, date_val: date, sem: asyncio.Semaphore):
    """Download single daily index CSV file."""
    date_str = date_val.strftime("%d%m%Y")
    url = f"https://nsearchives.nseindia.com/content/indices/ind_close_all_{date_str}.csv"
    async with sem:
        try:
            resp = await client.get(url, timeout=10)
            if resp.status_code == 200:
                return date_val, resp.text
            elif resp.status_code == 404:
                return date_val, None
            else:
                logger.warning(f"Failed {url} with status {resp.status_code}")
                return date_val, None
        except Exception as e:
            # logger.debug(f"Error downloading {url}: {e}")
            return date_val, None

async def download_historical_indices(start_date: date, end_date: date):
    """Download all daily index files in parallel."""
    import httpx
    
    dates = []
    curr = start_date
    while curr <= end_date:
        # Exclude weekends (5 = Saturday, 6 = Sunday)
        if curr.weekday() < 5:
            dates.append(curr)
        curr += timedelta(days=1)
        
    logger.info(f"Downloading historical index data for {len(dates)} potential trading days...")
    
    sem = asyncio.Semaphore(40)
    async with httpx.AsyncClient(headers=NSE_HEADERS, follow_redirects=True) as client:
        tasks = [download_index_eod_day(client, d, sem) for d in dates]
        results = await asyncio.gather(*tasks)
        
    # Filter only successful downloads
    data_by_date = {d: content for d, content in results if content is not None}
    logger.info(f"Successfully downloaded index data for {len(data_by_date)} trading days.")
    return data_by_date

def process_historical_indices(engine, data_by_date):
    """Parse index daily files and insert into database."""
    logger.info("Processing index data and inserting into DB...")
    
    with Session(engine) as session:
        # Get all index instrument ids
        result = session.execute(text("SELECT id, name, symbol FROM instruments WHERE segment = 'IND'")).fetchall()
        name_to_id = {row[1]: row[0] for row in result}
        
        total_inserted = 0
        records = []
        
        for d, content in data_by_date.items():
            f = io.StringIO(content)
            reader = csv.DictReader(f)
            
            # Strip column names
            reader.fieldnames = [name.strip() for name in reader.fieldnames]
            
            for row in reader:
                idx_name = row.get("Index Name")
                if not idx_name:
                    continue
                idx_name = idx_name.strip()
                
                # Check if this is one of our indices
                if idx_name in name_to_id:
                    iid = name_to_id[idx_name]
                    
                    try:
                        open_val = row.get("Open Index Value")
                        high_val = row.get("High Index Value")
                        low_val = row.get("Low Index Value")
                        close_val = row.get("Closing Index Value")
                        volume_val = row.get("Volume", "0")
                        
                        # Handle '-' or empty values
                        def clean_float(val):
                            if not val or val.strip() == "-":
                                return None
                            return float(val.strip().replace(",", ""))
                            
                        def clean_int(val):
                            if not val or val.strip() == "-":
                                return 0
                            return int(val.strip().replace(",", ""))
                            
                        o = clean_float(open_val)
                        h = clean_float(high_val)
                        l = clean_float(low_val)
                        c = clean_float(close_val)
                        v = clean_int(volume_val)
                        
                        if c is not None:
                            records.append({
                                "time": d,
                                "iid": iid,
                                "o": o,
                                "h": h,
                                "l": l,
                                "c": c,
                                "v": v
                            })
                    except Exception as e:
                        logger.error(f"Error parsing row for {idx_name} on {d}: {e}")
                        
        if records:
            # Batch upsert
            session.execute(
                text(
                    "INSERT INTO ohlcv_eod (time, instrument_id, open, high, low, close, volume) "
                    "VALUES (:time, :iid, :o, :h, :l, :c, :v) "
                    "ON CONFLICT (instrument_id, time) DO UPDATE SET "
                    "open=EXCLUDED.open, high=EXCLUDED.high, low=EXCLUDED.low, "
                    "close=EXCLUDED.close, volume=EXCLUDED.volume"
                ),
                records
            )
            total_inserted = len(records)
            session.commit()
            
    logger.info(f"Finished processing indices. Inserted/Updated {total_inserted} rows.")

def backfill_constituent_stocks(engine, all_symbols, period="5y"):
    """Backfill EOD data for constituent stocks from Yahoo Finance."""
    logger.info(f"Backfilling {period} historical data for {len(all_symbols)} constituent stocks from Yahoo Finance...")
    
    # Map symbols to ids
    with Session(engine) as session:
        instruments = session.execute(
            text("SELECT id, symbol FROM instruments WHERE segment = 'EQ' AND is_active = 1")
        ).fetchall()
        sym_to_id = {sym: iid for iid, sym in instruments}
        
    tickers_list = [f"{sym}.NS" for sym in all_symbols if sym in sym_to_id]
    
    # We download in chunks of 50 to stay safe and quick
    chunk_size = 50
    total_upserts = 0
    
    # Setup custom yfinance session with User-Agent
    custom_session = requests.Session()
    custom_session.headers.update({
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    })
    
    for i in range(0, len(tickers_list), chunk_size):
        chunk = tickers_list[i : i + chunk_size]
        logger.info(f"Downloading chunk {i // chunk_size + 1} ({len(chunk)} tickers)...")
        
        try:
            # Batch download
            df = yf.download(
                chunk,
                period=period,
                interval="1d",
                group_by="ticker",
                auto_adjust=True,
                progress=False
            )
            
            with Session(engine) as session:
                if len(chunk) == 1:
                    ticker = chunk[0]
                    sym = ticker.replace(".NS", "")
                    if sym not in sym_to_id:
                        continue
                    iid = sym_to_id[sym]
                    ticker_df = df.dropna(subset=["Open", "High", "Low", "Close"]).copy()
                    
                    records = []
                    for dt, row in ticker_df.iterrows():
                        records.append({
                            "time": dt.date(),
                            "iid": iid,
                            "o": float(row["Open"]),
                            "h": float(row["High"]),
                            "l": float(row["Low"]),
                            "c": float(row["Close"]),
                            "v": int(row["Volume"]) if pd.notnull(row["Volume"]) else 0,
                        })
                    if records:
                        session.execute(
                            text(
                                "INSERT INTO ohlcv_eod (time, instrument_id, open, high, low, close, volume) "
                                "VALUES (:time, :iid, :o, :h, :l, :c, :v) "
                                "ON CONFLICT (instrument_id, time) DO UPDATE SET "
                                "open=EXCLUDED.open, high=EXCLUDED.high, low=EXCLUDED.low, "
                                "close=EXCLUDED.close, volume=EXCLUDED.volume"
                            ),
                            records
                        )
                        total_upserts += len(records)
                else:
                    for ticker in chunk:
                        if ticker not in df.columns.levels[0]:
                            continue
                        sym = ticker.replace(".NS", "")
                        if sym not in sym_to_id:
                            continue
                        iid = sym_to_id[sym]
                        
                        ticker_df = df[ticker].dropna(subset=["Open", "High", "Low", "Close"]).copy()
                        if ticker_df.empty:
                            continue
                            
                        records = []
                        for dt, row in ticker_df.iterrows():
                            records.append({
                                "time": dt.date(),
                                "iid": iid,
                                "o": float(row["Open"]),
                                "h": float(row["High"]),
                                "l": float(row["Low"]),
                                "c": float(row["Close"]),
                                "v": int(row["Volume"]) if pd.notnull(row["Volume"]) else 0,
                            })
                        if records:
                            session.execute(
                                text(
                                    "INSERT INTO ohlcv_eod (time, instrument_id, open, high, low, close, volume) "
                                    "VALUES (:time, :iid, :o, :h, :l, :c, :v) "
                                    "ON CONFLICT (instrument_id, time) DO UPDATE SET "
                                    "open=EXCLUDED.open, high=EXCLUDED.high, low=EXCLUDED.low, "
                                    "close=EXCLUDED.close, volume=EXCLUDED.volume"
                                ),
                                records
                            )
                            total_upserts += len(records)
                session.commit()
                logger.info(f"Chunk {i // chunk_size + 1} committed. Total records so far: {total_upserts}")
                
        except Exception as e:
            logger.error(f"Error downloading chunk: {e}. Retrying individually...")
            # Fallback to individual rate-limited download
            for ticker in chunk:
                sym = ticker.replace(".NS", "")
                if sym not in sym_to_id:
                    continue
                iid = sym_to_id[sym]
                try:
                    logger.info(f"Downloading {ticker} individually...")
                    ind_df = yf.download(
                        ticker,
                        period=period,
                        interval="1d",
                        auto_adjust=True,
                        progress=False
                    )
                    if not ind_df.empty:
                        # Droplevel if MultiIndex
                        if isinstance(ind_df.columns, pd.MultiIndex):
                            ind_df.columns = ind_df.columns.droplevel(1)
                            
                        ind_df = ind_df.dropna(subset=["Open", "High", "Low", "Close"]).copy()
                        records = []
                        for dt, row in ind_df.iterrows():
                            records.append({
                                "time": dt.date(),
                                "iid": iid,
                                "o": float(row["Open"]),
                                "h": float(row["High"]),
                                "l": float(row["Low"]),
                                "c": float(row["Close"]),
                                "v": int(row["Volume"]) if pd.notnull(row["Volume"]) else 0,
                            })
                        if records:
                            with Session(engine) as session:
                                session.execute(
                                    text(
                                        "INSERT INTO ohlcv_eod (time, instrument_id, open, high, low, close, volume) "
                                        "VALUES (:time, :iid, :o, :h, :l, :c, :v) "
                                        "ON CONFLICT (instrument_id, time) DO UPDATE SET "
                                        "open=EXCLUDED.open, high=EXCLUDED.high, low=EXCLUDED.low, "
                                        "close=EXCLUDED.close, volume=EXCLUDED.volume"
                                    ),
                                    records
                                )
                                session.commit()
                            total_upserts += len(records)
                except Exception as ex:
                    logger.error(f"Failed to download {ticker} individually: {ex}")
                import time
                time.sleep(1.5)  # sleep 1.5s to avoid rate limits
                
    logger.info(f"✅ Stock Backfill complete. Inserted/Updated {total_upserts} records.")

def main():
    engine = get_engine()
    
    # 1. Download constituents for all 23 indices and find unique stocks
    all_constituents = {}
    unique_stocks = {}
    
    for idx_name, url in INDEX_LISTS.items():
        symbols = download_constituents(idx_name, url)
        all_constituents[idx_name] = symbols
        for sym_info in symbols:
            unique_stocks[sym_info["symbol"]] = sym_info
            
    logger.info(f"Total unique constituent stocks found: {len(unique_stocks)}")
    
    # 2. Insert missing instruments (segment='EQ') and 23 indices (segment='IND')
    with Session(engine) as session:
        # A. Register the 23 indices
        for idx_name, meta in INDEX_METADATA.items():
            result = session.execute(
                text("SELECT id FROM instruments WHERE symbol = :sym"),
                {"sym": meta["symbol"]}
            ).fetchone()
            if not result:
                logger.info(f"Adding index instrument: {meta['symbol']} ({meta['name']})")
                session.execute(
                    text(
                        "INSERT INTO instruments (symbol, name, exchange, segment, is_active) "
                        "VALUES (:sym, :name, 'NSE', 'IND', 1)"
                    ),
                    {"sym": meta["symbol"], "name": meta["name"]}
                )
                
        # B. Register the constituent stocks
        for sym, info in unique_stocks.items():
            result = session.execute(
                text("SELECT id FROM instruments WHERE symbol = :sym"),
                {"sym": sym}
            ).fetchone()
            if not result:
                logger.info(f"Adding constituent stock: {sym} ({info['name']})")
                session.execute(
                    text(
                        "INSERT INTO instruments (symbol, name, exchange, segment, isin, is_active) "
                        "VALUES (:sym, :name, 'NSE', 'EQ', :isin, 1)"
                    ),
                    {"sym": sym, "name": info["name"], "isin": info["isin"]}
                )
        session.commit()
        
    # 3. Download and backfill 5 years of historical index values
    # Five years ago from June 14, 2026 is June 14, 2021
    start_date = date(2021, 6, 14)
    end_date = date(2026, 6, 14)
    
    data_by_date = asyncio.run(download_historical_indices(start_date, end_date))
    process_historical_indices(engine, data_by_date)
    
    # 4. Backfill 5 years of stock EOD data
    backfill_constituent_stocks(engine, sorted(list(unique_stocks.keys())), period="5y")
    
    # 5. Run Pattern and Trendline scans
    logger.info("Triggering pattern scans and trendline scans...")
    venv_python = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "venv", "bin", "python")
    scan_script = "import sys; sys.path.append('app/workers'); from tasks_eod import run_pattern_scan, run_trendline_scan; run_pattern_scan(); run_trendline_scan()"
    import subprocess
    env = os.environ.copy()
    env["DATABASE_URL"] = settings.DATABASE_URL
    subprocess.run([venv_python, "-c", scan_script], env=env)
    
    logger.info("🎉 Database seeding and backfill complete!")

if __name__ == "__main__":
    main()
