"""PEESTOCK — Seed and backfill remaining broad-market Nifty indices and their constituents from IPO."""

import os
import sys
import csv
import io
import time
import logging
import requests
import pandas as pd
import yfinance as yf
from datetime import date, datetime
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

LEFT_INDICES = {
    "Nifty Next 50": {
        "symbol": "NIFTY_NEXT_50",
        "yticker": "^NSMIDCP",
        "url": "https://archives.nseindia.com/content/indices/ind_niftynext50list.csv"
    },
    "Nifty 100": {
        "symbol": "NIFTY_100",
        "yticker": "^CNX100",
        "url": "https://archives.nseindia.com/content/indices/ind_nifty100list.csv"
    },
    "Nifty 200": {
        "symbol": "NIFTY_200",
        "yticker": "^CNX200",
        "url": "https://archives.nseindia.com/content/indices/ind_nifty200list.csv"
    },
    "Nifty 500": {
        "symbol": "NIFTY_500",
        "yticker": "^CRSLDX",
        "url": "https://archives.nseindia.com/content/indices/ind_nifty500list.csv"
    },
    "Nifty Midcap 50": {
        "symbol": "NIFTY_MIDCAP_50",
        "yticker": "^NSEMDCP50",
        "url": "https://archives.nseindia.com/content/indices/ind_niftymidcap50list.csv"
    },
    "Nifty Midcap 100": {
        "symbol": "NIFTY_MIDCAP_100",
        "yticker": "NIFTY_MIDCAP_100.NS",
        "url": "https://archives.nseindia.com/content/indices/ind_niftymidcap100list.csv"
    },
    "Nifty Smallcap 50": {
        "symbol": "NIFTY_SMALLCAP_50",
        "yticker": None,
        "url": "https://archives.nseindia.com/content/indices/ind_niftysmallcap50list.csv"
    },
    "Nifty Smallcap 100": {
        "symbol": "NIFTY_SMALLCAP_100",
        "yticker": "^CNXSC",
        "url": "https://archives.nseindia.com/content/indices/ind_niftysmallcap100list.csv"
    },
    "Nifty MidSmallcap 400": {
        "symbol": "NIFTY_MIDSMALL_400",
        "yticker": None,
        "url": "https://archives.nseindia.com/content/indices/ind_niftymidsmallcap400list.csv"
    }
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

def download_constituents(name: str, url: str) -> list[dict]:
    """Download constituent list CSV and extract symbols/names."""
    logger.info(f"Downloading constituents for {name} from {url}")
    try:
        resp = requests.get(url, headers=NSE_HEADERS, timeout=15)
        resp.raise_for_status()
        
        f = io.StringIO(resp.text)
        reader = csv.DictReader(f)
        reader.fieldnames = [n.strip() for n in reader.fieldnames]
        
        symbols = []
        for row in reader:
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
                
        logger.info(f"Found {len(symbols)} constituents for {name}")
        return symbols
    except Exception as e:
        logger.error(f"Failed to download constituents for {name}: {e}")
        return []

def backfill_ohlcv(engine, iid, ticker, period="max"):
    """Download and ingest EOD data for a single instrument."""
    try:
        df = yf.download(ticker, period=period, interval="1d", auto_adjust=True, progress=False)
        if df.empty:
            logger.warning(f"No data returned for ticker {ticker}")
            return 0
            
        if isinstance(df.columns, pd.MultiIndex):
            df.columns = df.columns.droplevel(1)
        df = df.dropna(subset=["Open", "High", "Low", "Close"]).copy()
        
        records = []
        for dt, row in df.iterrows():
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
            return len(records)
    except Exception as e:
        logger.error(f"Error backfilling {ticker}: {e}")
    return 0

def main():
    engine = get_engine()
    
    # Ensure index_constituents table exists
    Base.metadata.create_all(engine)
    
    # 1. Load stocks and indices from DB to map symbols to IDs (including inactive ones)
    with Session(engine) as session:
        instruments = session.execute(
            text("SELECT id, symbol, segment FROM instruments")
        ).fetchall()
    
    symbol_to_id = {row[1]: row[0] for row in instruments}
    logger.info(f"Loaded {len(symbol_to_id)} instruments from DB")

    new_stocks_to_backfill = []
    mapped_relationships = 0

    # 2. Process each of the 9 broad indices
    for idx_name, meta in LEFT_INDICES.items():
        symbol = meta["symbol"]
        yticker = meta["yticker"]
        url = meta["url"]
        
        # A. Register the Index instrument if not exists
        with Session(engine) as session:
            session.execute(
                text(
                    "INSERT INTO instruments (symbol, name, exchange, segment, is_active) "
                    "VALUES (:sym, :name, 'NSE', 'IND', 1) "
                    "ON CONFLICT (symbol) DO UPDATE SET is_active = 1"
                ),
                {"sym": symbol, "name": idx_name}
            )
            session.commit()
            
            # Reload ID
            result = session.execute(
                text("SELECT id FROM instruments WHERE symbol = :sym"),
                {"sym": symbol}
            ).fetchone()
                
            index_id = result[0]
            symbol_to_id[symbol] = index_id

        # B. Download constituents
        constituents = download_constituents(idx_name, url)
        if not constituents:
            continue
            
        # C. Register constituent stocks and map them
        with Session(engine) as session:
            # First, clear existing constituents for this index to avoid duplicates
            session.execute(
                text("DELETE FROM index_constituents WHERE index_id = :index_id"),
                {"index_id": index_id}
            )
            session.commit()
            
            records_to_map = []
            for item in constituents:
                stock_sym = item["symbol"]
                
                # Check if stock exists
                stock_id = symbol_to_id.get(stock_sym)
                if not stock_id:
                    # Register stock
                    logger.info(f"Registering new constituent stock: {stock_sym} ({item['name']})")
                    session.execute(
                        text(
                            "INSERT INTO instruments (symbol, name, exchange, segment, isin, is_active) "
                            "VALUES (:sym, :name, 'NSE', 'EQ', :isin, 1) "
                            "ON CONFLICT (symbol) DO UPDATE SET is_active = 1"
                        ),
                        {"sym": stock_sym, "name": item["name"], "isin": item["isin"]}
                    )
                    session.commit()
                    # Reload ID
                    res_stock = session.execute(
                        text("SELECT id FROM instruments WHERE symbol = :sym"),
                        {"sym": stock_sym}
                    ).fetchone()
                    stock_id = res_stock[0]
                    symbol_to_id[stock_sym] = stock_id
                    new_stocks_to_backfill.append((stock_id, stock_sym))
                else:
                    # Existing stock — let's check if it has sufficient history in the DB
                    # (less than 100 rows means it needs a backfill)
                    history_count = session.execute(
                        text("SELECT COUNT(*) FROM ohlcv_eod WHERE instrument_id = :iid"),
                        {"iid": stock_id}
                    ).scalar()
                    if history_count < 100:
                        logger.info(f"Stock {stock_sym} has incomplete history ({history_count} rows). Adding to backfill list.")
                        new_stocks_to_backfill.append((stock_id, stock_sym))
                        
                records_to_map.append({
                    "index_id": index_id,
                    "instrument_id": stock_id
                })
                
            if records_to_map:
                session.execute(
                    text(
                        "INSERT OR IGNORE INTO index_constituents (index_id, instrument_id) "
                        "VALUES (:index_id, :instrument_id)"
                    ),
                    records_to_map
                )
                session.commit()
                logger.info(f"Mapped {len(records_to_map)} constituents for {idx_name}")
                mapped_relationships += len(records_to_map)

    # 3. Backfill newly added or incomplete stocks from IPO
    logger.info(f"Starting historical backfill from IPO for {len(new_stocks_to_backfill)} stocks...")
    stock_records_ingested = 0
    for idx, (iid, sym) in enumerate(new_stocks_to_backfill):
        ticker = f"{sym}.NS"
        logger.info(f"[{idx+1}/{len(new_stocks_to_backfill)}] Backfilling stock {sym} from IPO...")
        rows = backfill_ohlcv(engine, iid, ticker, period="max")
        logger.info(f"Ingested {rows} EOD bars for {sym}")
        stock_records_ingested += rows
        time.sleep(0.5)

    # 4. Backfill newly added Index historical price data
    logger.info("Starting historical backfill from inception for Index tickers...")
    index_records_ingested = 0
    for idx_name, meta in LEFT_INDICES.items():
        symbol = meta["symbol"]
        yticker = meta["yticker"]
        if not yticker:
            continue
            
        index_id = symbol_to_id.get(symbol)
        if not index_id:
            continue
            
        logger.info(f"Backfilling Index {symbol} via Yahoo ticker {yticker}...")
        rows = backfill_ohlcv(engine, index_id, yticker, period="max")
        logger.info(f"Ingested {rows} EOD bars for Index {symbol}")
        index_records_ingested += rows
        time.sleep(0.5)

    # 5. Run Price Cleanup (Spikes and Negative prices)
    logger.info("Cleaning non-positive prices (<= 0) and high/low spikes from database...")
    with Session(engine) as session:
        session.execute(text("""
            UPDATE ohlcv_eod
            SET open = CASE WHEN open <= 0 THEN 0.01 ELSE open END,
                high = CASE WHEN high <= 0 THEN 0.01 ELSE high END,
                low = CASE WHEN low <= 0 THEN 0.01 ELSE low END,
                close = CASE WHEN close <= 0 THEN 0.01 ELSE close END
            WHERE open <= 0 OR high <= 0 OR low <= 0 OR close <= 0
        """))
        session.execute(text("""
            UPDATE ohlcv_eod
            SET high = CASE WHEN open > close THEN open * 1.05 ELSE close * 1.05 END
            WHERE high > 1.25 * close AND high > 1.25 * open AND open > 0 AND close > 0
        """))
        session.execute(text("""
            UPDATE ohlcv_eod
            SET low = CASE WHEN open < close THEN open * 0.95 ELSE close * 0.95 END
            WHERE low < 0.75 * close AND low < 0.75 * open AND low > 0 AND open > 0 AND close > 0
        """))
        session.commit()
    logger.info("Database cleanup completed.")

    # 6. Trigger EOD Scans (Patterns and Trendlines)
    logger.info("Triggering pattern and trendline scans to process new history...")
    venv_python = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "venv", "bin", "python")
    scan_script = (
        "import sys; "
        "sys.path.append('app/workers'); "
        "from tasks_eod import run_pattern_scan, run_trendline_scan; "
        "run_pattern_scan(); "
        "run_trendline_scan()"
    )
    import subprocess
    env = os.environ.copy()
    env["DATABASE_URL"] = settings.DATABASE_URL
    subprocess.run([venv_python, "-c", scan_script], env=env)
    
    logger.info(f"🎉 Seeding and Ingestion Complete!")
    logger.info(f"Summary:")
    logger.info(f"  - Total Index-Constituent Mappings: {mapped_relationships}")
    logger.info(f"  - New/Incomplete Stocks Backfilled: {len(new_stocks_to_backfill)}")
    logger.info(f"  - Stock EOD Records Ingested: {stock_records_ingested}")
    logger.info(f"  - Index EOD Records Ingested: {index_records_ingested}")

if __name__ == "__main__":
    main()
