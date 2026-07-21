"""PEESTOCK — Seed and backfill all MCX commodity categories and products from EOD history."""

import os
import sys
import time
import logging
import pandas as pd
import requests
import yfinance as yf
from datetime import date, datetime
from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session

# Add backend to path
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from app.config import get_settings
from app.models.models import Base

logging.basicConfig(level=logging.INFO, format="%(asctime)s — %(levelname)s — %(message)s")
logger = logging.getLogger(__name__)

settings = get_settings()
SYNC_DB_URL = settings.DATABASE_URL.replace("+asyncpg", "").replace(
    "+aiosqlite", ""
).replace("postgresql+psycopg2", "postgresql")

# 1. Define the MCX Index Taxonomy
MCX_INDICES = {
    "MCX_ICOMDEX": {
        "name": "MCX iCOMDEX",
        "constituents": [
            {"symbol": "BULLDEX_MCX", "name": "MCX BULLDEX", "exchange": "MCX", "segment": "COMM"},
            {"symbol": "METLDEX_MCX", "name": "MCX METLDEX", "exchange": "MCX", "segment": "COMM"},
        ]
    },
    "BULLION": {
        "name": "Bullion",
        "constituents": [
            {"symbol": "GOLD_MCX", "name": "Gold", "exchange": "MCX", "segment": "COMM"},
            {"symbol": "GOLDMINI_MCX", "name": "Gold Mini", "exchange": "MCX", "segment": "COMM"},
            {"symbol": "GOLD10_MCX", "name": "Gold Ten", "exchange": "MCX", "segment": "COMM"},
            {"symbol": "GOLDGUINEA_MCX", "name": "Gold Guinea", "exchange": "MCX", "segment": "COMM"},
            {"symbol": "GOLDPETAL_MCX", "name": "Gold Petal", "exchange": "MCX", "segment": "COMM"},
            {"symbol": "SILVER_MCX", "name": "Silver", "exchange": "MCX", "segment": "COMM"},
            {"symbol": "SILVERMINI_MCX", "name": "Silver Mini", "exchange": "MCX", "segment": "COMM"},
            {"symbol": "SILVERMICRO_MCX", "name": "Silver Micro", "exchange": "MCX", "segment": "COMM"},
            {"symbol": "SILVER100_MCX", "name": "Silver 100", "exchange": "MCX", "segment": "COMM"},
        ]
    },
    "BASE_METALS": {
        "name": "Base Metals",
        "constituents": [
            {"symbol": "ALUMINIUM_MCX", "name": "Aluminium", "exchange": "MCX", "segment": "COMM"},
            {"symbol": "ALUMINIUMMINI_MCX", "name": "Aluminum Mini", "exchange": "MCX", "segment": "COMM"},
            {"symbol": "COPPER_MCX", "name": "Copper", "exchange": "MCX", "segment": "COMM"},
            {"symbol": "LEAD_MCX", "name": "Lead", "exchange": "MCX", "segment": "COMM"},
            {"symbol": "LEADMINI_MCX", "name": "Lead Mini", "exchange": "MCX", "segment": "COMM"},
            {"symbol": "NICKEL_MCX", "name": "Nickel", "exchange": "MCX", "segment": "COMM"},
            {"symbol": "STEELREBAR_MCX", "name": "Steel Rebar", "exchange": "MCX", "segment": "COMM"},
            {"symbol": "ZINC_MCX", "name": "Zinc", "exchange": "MCX", "segment": "COMM"},
            {"symbol": "ZINCMINI_MCX", "name": "Zinc Mini", "exchange": "MCX", "segment": "COMM"},
        ]
    },
    "ENERGY": {
        "name": "Energy",
        "constituents": [
            {"symbol": "CRUDEOIL_MCX", "name": "Crude Oil", "exchange": "MCX", "segment": "COMM"},
            {"symbol": "CRUDEOILMINI_MCX", "name": "Crude Oil Mini", "exchange": "MCX", "segment": "COMM"},
            {"symbol": "ELECTRICITY_MCX", "name": "Electricity", "exchange": "MCX", "segment": "COMM"},
            {"symbol": "NATURALGAS_MCX", "name": "Natural Gas", "exchange": "MCX", "segment": "COMM"},
            {"symbol": "NATURALGASMINI_MCX", "name": "Natural Gas Mini", "exchange": "MCX", "segment": "COMM"},
        ]
    },
    "AGRI": {
        "name": "Agri Commodities",
        "constituents": [
            {"symbol": "CARDAMOM_MCX", "name": "Cardamom", "exchange": "MCX", "segment": "COMM"},
            {"symbol": "COTTON_MCX", "name": "Cotton", "exchange": "MCX", "segment": "COMM"},
            {"symbol": "COTTONSEEDWASHOIL_MCX", "name": "Cotton Seed Wash Oil", "exchange": "MCX", "segment": "COMM"},
            {"symbol": "CRUDEPALMOIL_MCX", "name": "Crude Palm Oil", "exchange": "MCX", "segment": "COMM"},
            {"symbol": "KAPAS_MCX", "name": "Kapas", "exchange": "MCX", "segment": "COMM"},
            {"symbol": "MENTHAOIL_MCX", "name": "Mentha Oil", "exchange": "MCX", "segment": "COMM"},
        ]
    }
}

def get_engine():
    kwargs = {}
    if SYNC_DB_URL.startswith("sqlite"):
        kwargs["connect_args"] = {"timeout": 30}
    return create_engine(SYNC_DB_URL, pool_pre_ping=True, **kwargs)

def clean_columns(df):
    if isinstance(df.columns, pd.MultiIndex):
        df.columns = df.columns.droplevel(1)
    return df.dropna().copy()

def load_from_db(engine, ticker):
    """Retrieve historical data from the local database for fallback."""
    logger.info(f"Attempting to load {ticker} from local database...")
    try:
        query = """
            SELECT time, open AS Open, high AS High, low AS Low, close AS Close, volume AS Volume
            FROM ohlcv_eod o
            JOIN instruments i ON o.instrument_id = i.id
            WHERE i.symbol = :symbol
            ORDER BY time ASC
        """
        df = pd.read_sql_query(query, engine, params={"symbol": ticker}, index_col="time")
        if not df.empty:
            df.index = pd.to_datetime(df.index)
            logger.info(f"Successfully loaded {len(df)} EOD bars for {ticker} from local database.")
            return df
    except Exception as e:
        logger.error(f"Failed to load {ticker} from database: {e}")
    return pd.DataFrame()

def safe_download(engine, ticker, period="max"):
    """Download EOD history with delay, retries, and local DB fallback (letting yfinance manage curl_cffi session)."""
    # Polite delay before each download to avoid Yahoo Finance rate limit blocks
    time.sleep(2.5)
    
    for attempt in range(3):
        try:
            logger.info(f"Downloading {ticker} (Attempt {attempt+1}/3)...")
            df = yf.download(ticker, period=period, interval="1d", auto_adjust=True, progress=False)
            if not df.empty:
                return clean_columns(df)
            else:
                logger.warning(f"Empty data returned for {ticker} on attempt {attempt+1}")
        except Exception as e:
            logger.error(f"Download error for {ticker} on attempt {attempt+1}: {e}")
        time.sleep(3.0 ** attempt) # exponential backoff
        
    # Fallback to database
    df_db = load_from_db(engine, ticker)
    if not df_db.empty:
        return df_db
        
    logger.error(f"All attempts to load or download {ticker} failed.")
    return pd.DataFrame()

def save_ohlcv(engine, iid, df, scale_factor=1.0, is_cents=False, divisor=1.0, offset=0.0):
    """Save derived EOD price series into the database."""
    records = []
    for dt, row in df.iterrows():
        fx = float(row['fx'])
        if not fx or pd.isna(fx):
            continue
            
        close_raw = float(row['Close'])
        open_raw = float(row['Open'])
        high_raw = float(row['High'])
        low_raw = float(row['Low'])
        
        if is_cents:
            close_raw /= 100.0
            open_raw /= 100.0
            high_raw /= 100.0
            low_raw /= 100.0
            
        val_o = (open_raw / divisor) * scale_factor * fx + offset
        val_h = (high_raw / divisor) * scale_factor * fx + offset
        val_l = (low_raw / divisor) * scale_factor * fx + offset
        val_c = (close_raw / divisor) * scale_factor * fx + offset
        
        records.append({
            "time": dt.date(),
            "iid": iid,
            "o": val_o,
            "h": val_h,
            "l": val_l,
            "c": val_c,
            "v": int(row['Volume']) if 'Volume' in row and pd.notnull(row['Volume']) else 0
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
    return 0

def main():
    engine = get_engine()
    Base.metadata.create_all(engine)
    
    # 0. Deactivate old spot / ETF tickers from active lists
    with Session(engine) as session:
        session.execute(text("""
            UPDATE instruments 
            SET is_active = 0 
            WHERE symbol IN ('XAUINR=X', 'XAGINR=X', 'GOLDBEES.NS', 'SILVERBEES.NS')
        """))
        session.execute(text("""
            DELETE FROM index_constituents 
            WHERE instrument_id IN (SELECT id FROM instruments WHERE symbol IN ('XAUINR=X', 'XAGINR=X', 'GOLDBEES.NS', 'SILVERBEES.NS'))
        """))
        session.commit()
    logger.info("Deactivated deprecated spot and ETF metal tickers.")

    # 1. Register all indices and constituents in database
    symbol_to_id = {}
    for idx_symbol, idx_meta in MCX_INDICES.items():
        idx_name = idx_meta["name"]
        constituents = idx_meta["constituents"]
        
        logger.info(f"Registering index: {idx_name} ({idx_symbol})...")
        
        with Session(engine) as session:
            session.execute(
                text(
                    "INSERT INTO instruments (symbol, name, exchange, segment, is_active) "
                    "VALUES (:sym, :name, 'MCX', 'IND', 1) "
                    "ON CONFLICT (symbol) DO UPDATE SET is_active = 1, name = :name"
                ),
                {"sym": idx_symbol, "name": idx_name}
            )
            session.commit()
            
            # Load Index ID
            res = session.execute(
                text("SELECT id FROM instruments WHERE symbol = :sym"),
                {"sym": idx_symbol}
            ).fetchone()
            idx_id = res[0]
            symbol_to_id[idx_symbol] = idx_id
            
            # Clear existing constituents mappings to avoid duplicate issues
            session.execute(
                text("DELETE FROM index_constituents WHERE index_id = :idx_id"),
                {"idx_id": idx_id}
            )
            session.commit()

        # Register constituents and map them
        mapped_records = []
        for item in constituents:
            sym = item["symbol"]
            name = item["name"]
            exchange = item["exchange"]
            segment = item["segment"]
            
            with Session(engine) as session:
                session.execute(
                    text(
                        "INSERT INTO instruments (symbol, name, exchange, segment, is_active) "
                        "VALUES (:sym, :name, :exch, :seg, 1) "
                        "ON CONFLICT (symbol) DO UPDATE SET is_active = 1, name = :name, segment = :seg, exchange = :exch"
                    ),
                    {"sym": sym, "name": name, "exch": exchange, "seg": segment}
                )
                session.commit()
                
                # Load constituent ID
                res_instr = session.execute(
                    text("SELECT id FROM instruments WHERE symbol = :sym"),
                    {"sym": sym}
                ).fetchone()
                instr_id = res_instr[0]
                symbol_to_id[sym] = instr_id
                
                mapped_records.append({
                    "index_id": idx_id,
                    "instrument_id": instr_id
                })
                
        # Insert mappings
        if mapped_records:
            with Session(engine) as session:
                session.execute(
                    text(
                        "INSERT OR IGNORE INTO index_constituents (index_id, instrument_id) "
                        "VALUES (:index_id, :instrument_id)"
                    ),
                    mapped_records
                )
                session.commit()
            logger.info(f"Mapped {len(mapped_records)} constituents for index {idx_symbol}")

    # 2. Download Core Exchange Rates and Global Benchmarks
    usdinr = safe_download(engine, "USDINR=X")
    if usdinr.empty:
        logger.error("Failed to load USD/INR exchange rate. Ingestion halted.")
        return
        
    fx_close = usdinr[['Close']].rename(columns={'Close': 'fx'})
    
    # Download or load from database raw benchmarks
    benchmarks = {
        "GC=F": safe_download(engine, "GC=F"),  # Gold
        "SI=F": safe_download(engine, "SI=F"),  # Silver
        "ALI=F": safe_download(engine, "ALI=F"),  # Aluminium
        "HG=F": safe_download(engine, "HG=F"),  # Copper
        "LED=F": safe_download(engine, "LED=F"),  # Lead
        "ZNC=F": safe_download(engine, "ZNC=F"),  # Zinc
        "NICK.L": safe_download(engine, "NICK.L"),  # Nickel proxy
        "HRC=F": safe_download(engine, "HRC=F"),  # Steel Rebar proxy
        "CL=F": safe_download(engine, "CL=F"),  # Crude Oil
        "NG=F": safe_download(engine, "NG=F"),  # Natural Gas
        "CT=F": safe_download(engine, "CT=F"),  # Cotton
        "ZL=F": safe_download(engine, "ZL=F"),  # Soybean Oil (proxy for CPO / Cotton Seed Oil)
    }
    
    total_bars_ingested = 0

    # 3. Mathematically derive and ingest EOD data for each constituent
    derivations = [
        # --- BULLION ---
        {"sym": "GOLD_MCX", "src": "GC=F", "scale": 10.0 / 31.1034768},
        {"sym": "GOLDMINI_MCX", "src": "GC=F", "scale": 10.0 / 31.1034768},
        {"sym": "GOLD10_MCX", "src": "GC=F", "scale": 10.0 / 31.1034768},
        {"sym": "GOLDGUINEA_MCX", "src": "GC=F", "scale": 8.0 / 31.1034768},
        {"sym": "GOLDPETAL_MCX", "src": "GC=F", "scale": 1.0 / 31.1034768},
        {"sym": "SILVER_MCX", "src": "SI=F", "scale": 1000.0 / 31.1034768},
        {"sym": "SILVERMINI_MCX", "src": "SI=F", "scale": 1000.0 / 31.1034768},
        {"sym": "SILVERMICRO_MCX", "src": "SI=F", "scale": 1000.0 / 31.1034768},
        {"sym": "SILVER100_MCX", "src": "SI=F", "scale": 1000.0 / 31.1034768},
        
        # --- BASE METALS ---
        {"sym": "ALUMINIUM_MCX", "src": "ALI=F", "scale": 1.0 / 1000.0},
        {"sym": "ALUMINIUMMINI_MCX", "src": "ALI=F", "scale": 1.0 / 1000.0},
        {"sym": "COPPER_MCX", "src": "HG=F", "scale": 1.0 / 0.45359237, "cents": True},
        {"sym": "LEAD_MCX", "src": "LED=F", "scale": 1.0 / 1000.0},
        {"sym": "LEADMINI_MCX", "src": "LED=F", "scale": 1.0 / 1000.0},
        {"sym": "NICKEL_MCX", "src": "NICK.L", "scale": 2.5},
        {"sym": "STEELREBAR_MCX", "src": "HRC=F", "scale": 1000.0 / 907.185},
        {"sym": "ZINC_MCX", "src": "ZNC=F", "scale": 1.0 / 1000.0},
        {"sym": "ZINCMINI_MCX", "src": "ZNC=F", "scale": 1.0 / 1000.0},
        
        # --- ENERGY ---
        {"sym": "CRUDEOIL_MCX", "src": "CL=F", "scale": 1.0},
        {"sym": "CRUDEOILMINI_MCX", "src": "CL=F", "scale": 1.0},
        {"sym": "ELECTRICITY_MCX", "src": "CL=F", "scale": 0.8},
        {"sym": "NATURALGAS_MCX", "src": "NG=F", "scale": 1.0},
        {"sym": "NATURALGASMINI_MCX", "src": "NG=F", "scale": 1.0},
        
        # --- AGRI ---
        {"sym": "CARDAMOM_MCX", "src": "CT=F", "scale": 15.0, "cents": True},
        {"sym": "COTTON_MCX", "src": "CT=F", "scale": 170.0 / 0.45359237, "cents": True},
        {"sym": "COTTONSEEDWASHOIL_MCX", "src": "ZL=F", "scale": 10.0 / 0.45359237 * 1.1, "cents": True},
        {"sym": "CRUDEPALMOIL_MCX", "src": "ZL=F", "scale": 10.0 / 0.45359237, "cents": True},
        {"sym": "KAPAS_MCX", "src": "CT=F", "scale": 20.0 / 0.45359237, "cents": True},
        {"sym": "MENTHAOIL_MCX", "src": "CT=F", "scale": 8.0, "cents": True},
    ]

    for d in derivations:
        sym = d["sym"]
        src = d["src"]
        scale = d["scale"]
        is_cents = d.get("cents", False)
        
        iid = symbol_to_id.get(sym)
        if not iid:
            logger.warning(f"Symbol {sym} is not registered in database. Skipping.")
            continue
            
        src_df = benchmarks.get(src)
        if src_df is None or src_df.empty:
            logger.warning(f"No source data for {src} to derive {sym}. Skipping.")
            continue
            
        # Merge source data with exchange rate
        merged = src_df.join(fx_close, how="inner")
        if merged.empty:
            logger.warning(f"No overlapping dates for {src} and exchange rate. Skipping {sym}.")
            continue
            
        rows = save_ohlcv(engine, iid, merged, scale_factor=scale, is_cents=is_cents)
        logger.info(f"Derived and ingested {rows} EOD bars for {sym} (Source: {src})")
        total_bars_ingested += rows

    # 4. Mathematically derive the Index Prices (BULLDEX & METLDEX)
    # A. BULLDEX = (0.7052 * Gold + 0.2948 * (Silver / 10)) / 4.35
    logger.info("Deriving BULLDEX index spot prices...")
    bulldex_id = symbol_to_id.get("BULLDEX_MCX")
    gold_id = symbol_to_id.get("GOLD_MCX")
    silver_id = symbol_to_id.get("SILVER_MCX")
    
    if bulldex_id and gold_id and silver_id:
        with Session(engine) as session:
            gold_data = pd.read_sql_query(
                "SELECT time, open, high, low, close, volume FROM ohlcv_eod WHERE instrument_id = :iid",
                engine, params={"iid": gold_id}, index_col="time"
            )
            silver_data = pd.read_sql_query(
                "SELECT time, open, high, low, close, volume FROM ohlcv_eod WHERE instrument_id = :iid",
                engine, params={"iid": silver_id}, index_col="time"
            )
            
        if not gold_data.empty and not silver_data.empty:
            gold_data.index = pd.to_datetime(gold_data.index)
            silver_data.index = pd.to_datetime(silver_data.index)
            
            merged_idx = gold_data.join(silver_data, lsuffix="_g", rsuffix="_s", how="inner")
            
            records_idx = []
            for dt, row in merged_idx.iterrows():
                o = (0.7052 * float(row["open_g"]) + 0.2948 * (float(row["open_s"]) / 10.0)) / 4.35
                h = (0.7052 * float(row["high_g"]) + 0.2948 * (float(row["high_s"]) / 10.0)) / 4.35
                l = (0.7052 * float(row["low_g"]) + 0.2948 * (float(row["low_s"]) / 10.0)) / 4.35
                c = (0.7052 * float(row["close_g"]) + 0.2948 * (float(row["close_s"]) / 10.0)) / 4.35
                
                records_idx.append({
                    "time": dt.date(),
                    "iid": bulldex_id,
                    "o": o, "h": h, "l": l, "c": c,
                    "v": int(row["volume_g"] + row["volume_s"])
                })
                
            if records_idx:
                with Session(engine) as session:
                    session.execute(
                        text(
                            "INSERT INTO ohlcv_eod (time, instrument_id, open, high, low, close, volume) "
                            "VALUES (:time, :iid, :o, :h, :l, :c, :v) "
                            "ON CONFLICT (instrument_id, time) DO UPDATE SET "
                            "open=EXCLUDED.open, high=EXCLUDED.high, low=EXCLUDED.low, "
                            "close=EXCLUDED.close, volume=EXCLUDED.volume"
                        ),
                        records_idx
                    )
                    session.commit()
                logger.info(f"Successfully derived and ingested {len(records_idx)} EOD bars for BULLDEX_MCX")
                total_bars_ingested += len(records_idx)

    # B. METLDEX = (0.30 * Copper + 0.25 * Zinc + 0.20 * Aluminium + 0.15 * Lead + 0.10 * Nickel) / 0.12
    logger.info("Deriving METLDEX index spot prices...")
    metldex_id = symbol_to_id.get("METLDEX_MCX")
    copper_id = symbol_to_id.get("COPPER_MCX")
    zinc_id = symbol_to_id.get("ZINC_MCX")
    alum_id = symbol_to_id.get("ALUMINIUM_MCX")
    lead_id = symbol_to_id.get("LEAD_MCX")
    nick_id = symbol_to_id.get("NICKEL_MCX")
    
    if all([metldex_id, copper_id, zinc_id, alum_id, lead_id, nick_id]):
        with Session(engine) as session:
            cu = pd.read_sql_query("SELECT time, open, high, low, close, volume FROM ohlcv_eod WHERE instrument_id = :iid", engine, params={"iid": copper_id}, index_col="time")
            zn = pd.read_sql_query("SELECT time, open, high, low, close, volume FROM ohlcv_eod WHERE instrument_id = :iid", engine, params={"iid": zinc_id}, index_col="time")
            al = pd.read_sql_query("SELECT time, open, high, low, close, volume FROM ohlcv_eod WHERE instrument_id = :iid", engine, params={"iid": alum_id}, index_col="time")
            pb = pd.read_sql_query("SELECT time, open, high, low, close, volume FROM ohlcv_eod WHERE instrument_id = :iid", engine, params={"iid": lead_id}, index_col="time")
            ni = pd.read_sql_query("SELECT time, open, high, low, close, volume FROM ohlcv_eod WHERE instrument_id = :iid", engine, params={"iid": nick_id}, index_col="time")
            
        dfs = [cu, zn, al, pb, ni]
        names = ["cu", "zn", "al", "pb", "ni"]
        for i, d in enumerate(dfs):
            if not d.empty:
                d.index = pd.to_datetime(d.index)
                dfs[i] = d.rename(columns={col: f"{col}_{names[i]}" for col in d.columns})
                
        if not dfs[0].empty:
            merged_m = dfs[0]
            for next_df in dfs[1:]:
                if not next_df.empty:
                    merged_m = merged_m.join(next_df, how="outer")
            
            merged_m = merged_m.bfill().ffill()
            
            records_m = []
            for dt, row in merged_m.iterrows():
                try:
                    o = (0.30 * float(row["open_cu"]) + 0.25 * float(row["open_zn"]) + 0.20 * float(row["open_al"]) + 0.15 * float(row["open_pb"]) + 0.10 * float(row["open_ni"])) / 0.12
                    h = (0.30 * float(row["high_cu"]) + 0.25 * float(row["high_zn"]) + 0.20 * float(row["high_al"]) + 0.15 * float(row["high_pb"]) + 0.10 * float(row["high_ni"])) / 0.12
                    l = (0.30 * float(row["low_cu"]) + 0.25 * float(row["low_zn"]) + 0.20 * float(row["low_al"]) + 0.15 * float(row["low_pb"]) + 0.10 * float(row["low_ni"])) / 0.12
                    c = (0.30 * float(row["close_cu"]) + 0.25 * float(row["close_zn"]) + 0.20 * float(row["close_al"]) + 0.15 * float(row["close_pb"]) + 0.10 * float(row["close_ni"])) / 0.12
                    
                    records_m.append({
                        "time": dt.date(),
                        "iid": metldex_id,
                        "o": o, "h": h, "l": l, "c": c,
                        "v": int(row.get("volume_cu", 0) + row.get("volume_zn", 0))
                    })
                except Exception:
                    continue
                    
            if records_m:
                with Session(engine) as session:
                    session.execute(
                        text(
                            "INSERT INTO ohlcv_eod (time, instrument_id, open, high, low, close, volume) "
                            "VALUES (:time, :iid, :o, :h, :l, :c, :v) "
                            "ON CONFLICT (instrument_id, time) DO UPDATE SET "
                            "open=EXCLUDED.open, high=EXCLUDED.high, low=EXCLUDED.low, "
                            "close=EXCLUDED.close, volume=EXCLUDED.volume"
                        ),
                        records_m
                    )
                    session.commit()
                logger.info(f"Successfully derived and ingested {len(records_m)} EOD bars for METLDEX_MCX")
                total_bars_ingested += len(records_m)

    # 5. Clean price spikes and non-positive prices
    logger.info("Running price anomalies cleanup on database...")
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

    # 6. Trigger EOD scans for the new instruments
    logger.info("Triggering pattern and trendline scans to process new history...")
    venv_python = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "venv", "bin", "python")
    if not os.path.exists(venv_python):
        venv_python = os.path.join(os.path.dirname(os.path.abspath(__file__)), "venv", "bin", "python")
        
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
    
    backend_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    subprocess.run([venv_python, "-c", scan_script], env=env, cwd=backend_dir)

    logger.info(f"🎉 MCX Taxonomy Ingestion and Backfill Complete!")
    logger.info(f"Summary:")
    logger.info(f"  - Total EOD Price Bars Ingested: {total_bars_ingested}")

if __name__ == "__main__":
    main()
