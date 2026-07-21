"""PEESTOCK — EOD Data Ingestion Tasks.

Handles bhavcopy download, pattern scanning, and trendline detection.
"""

import io
import logging
from datetime import date, datetime, timezone
from typing import Optional
from zipfile import ZipFile

import httpx
import pandas as pd
from sqlalchemy import create_engine, select, text
from sqlalchemy.orm import Session

from app.workers.celery_app import celery_app
from app.config import get_settings

logger = logging.getLogger(__name__)

settings = get_settings()

# Sync engine for Celery (Celery doesn't support async)
SYNC_DB_URL = settings.DATABASE_URL.replace("+asyncpg", "").replace(
    "+aiosqlite", ""
).replace("postgresql+psycopg2", "postgresql")


def _get_sync_engine():
    kwargs = {}
    if SYNC_DB_URL.startswith("sqlite"):
        kwargs["connect_args"] = {"timeout": 30}
    return create_engine(SYNC_DB_URL, pool_pre_ping=True, **kwargs)


# ── NSE Bhavcopy Download ──────────────────────────────────

NSE_BHAVCOPY_URL = (
    "https://nsearchives.nseindia.com/content/historical/EQUITIES/"
    "{year}/{month}/cm{date}bhav.csv.zip"
)

NSE_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.5",
    "Referer": "https://www.nseindia.com/",
}


def _download_bhavcopy(target_date: date) -> Optional[pd.DataFrame]:
    """Download and parse NSE bhavcopy CSV for a given date."""
    date_str = target_date.strftime("%d%b%Y").upper()
    year = target_date.strftime("%Y")
    month = target_date.strftime("%b").upper()

    url = NSE_BHAVCOPY_URL.format(year=year, month=month, date=date_str)
    logger.info(f"Downloading bhavcopy from {url}")

    try:
        with httpx.Client(timeout=30, follow_redirects=True) as client:
            # First get cookies from NSE homepage
            client.get("https://www.nseindia.com/", headers=NSE_HEADERS)
            resp = client.get(url, headers=NSE_HEADERS)
            resp.raise_for_status()

        with ZipFile(io.BytesIO(resp.content)) as zf:
            csv_name = zf.namelist()[0]
            with zf.open(csv_name) as f:
                df = pd.read_csv(f)

        # Filter only EQ series (cash equities, no F&O)
        df = df[df["SERIES"].isin(["EQ", "BE"])]
        df = df.rename(columns={
            "SYMBOL": "symbol",
            "OPEN": "open",
            "HIGH": "high",
            "LOW": "low",
            "CLOSE": "close",
            "TOTTRDQTY": "volume",
            "TOTRDVAL": "turnover",
            "TIMESTAMP": "date",
        })
        df["date"] = pd.to_datetime(df["date"])
        logger.info(f"Bhavcopy: {len(df)} EQ records for {target_date}")
        return df

    except httpx.HTTPStatusError as e:
        logger.warning(f"Bhavcopy download failed ({e.response.status_code}): {url}")
        return None
    except Exception as e:
        logger.error(f"Bhavcopy error: {e}")
        return None


def _download_index_data(target_date: date) -> Optional[list[dict]]:
    """Download and parse daily index bhavcopy for a given date."""
    date_str = target_date.strftime("%d%m%Y")
    url = f"https://nsearchives.nseindia.com/content/indices/ind_close_all_{date_str}.csv"
    logger.info(f"Downloading index bhavcopy from {url}")
    
    try:
        with httpx.Client(timeout=30, follow_redirects=True) as client:
            client.get("https://www.nseindia.com/", headers=NSE_HEADERS)
            resp = client.get(url, headers=NSE_HEADERS)
            if resp.status_code == 404:
                logger.warning(f"Index bhavcopy not found (404) for {target_date}")
                return None
            resp.raise_for_status()

        import csv
        f = io.StringIO(resp.text)
        reader = csv.DictReader(f)
        reader.fieldnames = [name.strip() for name in reader.fieldnames]
        
        index_mapping = {
            "Nifty 50": "NIFTY_50",
            "Nifty Auto": "NIFTY_AUTO",
            "Nifty Bank": "NIFTY_BANK",
            "Nifty Cement": "NIFTY_CEMENT",
            "Nifty Chemicals": "NIFTY_CHEMICALS",
            "Nifty Financial Services": "NIFTY_FIN_SERVICES",
            "Nifty Financial Services 25/50": "NIFTY_FIN_SERVICES_25_50",
            "Nifty Financial Services Ex-Bank": "NIFTY_FIN_SERVICES_EX_BANK",
            "Nifty FMCG": "NIFTY_FMCG",
            "Nifty Healthcare Index": "NIFTY_HEALTHCARE",
            "Nifty IT": "NIFTY_IT",
            "Nifty Media": "NIFTY_MEDIA",
            "Nifty Metal": "NIFTY_METAL",
            "Nifty Pharma": "NIFTY_PHARMA",
            "Nifty Private Bank": "NIFTY_PRIVATE_BANK",
            "Nifty PSU Bank": "NIFTY_PSU_BANK",
            "Nifty Realty": "NIFTY_REALTY",
            "Nifty REITs & Realty": "NIFTY_REITS_REALTY",
            "Nifty Consumer Durables": "NIFTY_CONSUMER_DURABLES",
            "Nifty Oil & Gas": "NIFTY_OIL_GAS",
            "Nifty500 Healthcare": "NIFTY_500_HEALTHCARE",
            "Nifty MidSmall Financial Services": "NIFTY_MIDSMALL_FIN_SERVICES",
            "Nifty MidSmall Healthcare": "NIFTY_MIDSMALL_HEALTHCARE",
            "Nifty MidSmall IT & Telecom": "NIFTY_MIDSMALL_IT_TELECOM",
        }
        
        records = []
        for row in reader:
            idx_name = row.get("Index Name")
            if not idx_name:
                continue
            idx_name = idx_name.strip()
            
            if idx_name in index_mapping:
                symbol = index_mapping[idx_name]
                
                try:
                    open_val = row.get("Open Index Value")
                    high_val = row.get("High Index Value")
                    low_val = row.get("Low Index Value")
                    close_val = row.get("Closing Index Value")
                    volume_val = row.get("Volume", "0")
                    
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
                            "symbol": symbol,
                            "open": o,
                            "high": h,
                            "low": l,
                            "close": c,
                            "volume": v
                        })
                except Exception as e:
                    logger.error(f"Error parsing index row for {idx_name} on {target_date}: {e}")
                    
        return records
    except Exception as e:
        logger.error(f"Index bhavcopy error on {target_date}: {e}")
        return None


@celery_app.task(name="app.workers.tasks_eod.ingest_eod_data", bind=True, max_retries=3)
def ingest_eod_data(self, target_date: str = None):
    """Fetch and store end-of-day OHLCV data for all active instruments.

    Runs after market hours. Processes daily, then resamples to W/M.
    Also triggers pattern detection scan on updated data.
    """
    if target_date:
        dt = datetime.strptime(target_date, "%Y-%m-%d").date()
    else:
        dt = date.today()

    df = _download_bhavcopy(dt)
    idx_records = _download_index_data(dt)
    
    if (df is None or df.empty) and not idx_records:
        return {"status": "no_data", "date": str(dt)}

    engine = _get_sync_engine()
    inserted = 0

    with Session(engine) as session:
        if df is not None and not df.empty:
            for _, row in df.iterrows():
                symbol = row["symbol"]

                # Ensure instrument exists
                result = session.execute(
                    text("SELECT id FROM instruments WHERE symbol = :sym"),
                    {"sym": symbol},
                )
                instr = result.fetchone()

                if not instr:
                    session.execute(
                        text(
                            "INSERT INTO instruments (symbol, name, exchange, segment) "
                            "VALUES (:sym, :name, 'NSE', 'EQ') ON CONFLICT (symbol) DO NOTHING"
                        ),
                        {"sym": symbol, "name": symbol},
                    )
                    session.flush()
                    result = session.execute(
                        text("SELECT id FROM instruments WHERE symbol = :sym"),
                        {"sym": symbol},
                    )
                    instr = result.fetchone()

                if instr:
                    instrument_id = instr[0]
                    session.execute(
                        text(
                            "INSERT INTO ohlcv_eod (time, instrument_id, open, high, low, close, volume) "
                            "VALUES (:time, :iid, :o, :h, :l, :c, :v) "
                            "ON CONFLICT (instrument_id, time) DO UPDATE SET "
                            "open=EXCLUDED.open, high=EXCLUDED.high, low=EXCLUDED.low, "
                            "close=EXCLUDED.close, volume=EXCLUDED.volume"
                        ),
                        {
                            "time": dt,
                            "iid": instrument_id,
                            "o": float(row["open"]),
                            "h": float(row["high"]),
                            "l": float(row["low"]),
                            "c": float(row["close"]),
                            "v": int(row["volume"]),
                        },
                    )
                    inserted += 1

        if idx_records:
            for row in idx_records:
                symbol = row["symbol"]
                # Get instrument id for the index
                result = session.execute(
                    text("SELECT id FROM instruments WHERE symbol = :sym AND segment = 'IND'"),
                    {"sym": symbol},
                )
                instr = result.fetchone()
                if instr:
                    instrument_id = instr[0]
                    session.execute(
                        text(
                            "INSERT INTO ohlcv_eod (time, instrument_id, open, high, low, close, volume) "
                            "VALUES (:time, :iid, :o, :h, :l, :c, :v) "
                            "ON CONFLICT (instrument_id, time) DO UPDATE SET "
                            "open=EXCLUDED.open, high=EXCLUDED.high, low=EXCLUDED.low, "
                            "close=EXCLUDED.close, volume=EXCLUDED.volume"
                        ),
                        {
                            "time": dt,
                            "iid": instrument_id,
                            "o": row["open"],
                            "h": row["high"],
                            "l": row["low"],
                            "c": row["close"],
                            "v": row["volume"],
                        },
                    )
                    inserted += 1

        session.commit()

    logger.info(f"EOD ingestion complete: {inserted} records for {dt}")

    # Trigger pattern scan
    try:
        run_pattern_scan.delay()
        run_trendline_scan.delay()
    except Exception as e:
        logger.warning(f"Could not queue background scans (Redis down?): {e}")

    return {"status": "ok", "date": str(dt), "records": inserted}


@celery_app.task(name="app.workers.tasks_eod.run_pattern_scan")
def run_pattern_scan(instrument_id: int = None):
    """Run pattern detection engine on EOD data.

    If instrument_id is None, scans all active instruments.
    """
    from app.services.pattern_engine import PatternEngine

    engine_db = _get_sync_engine()
    pe = PatternEngine(pivot_lookback=3, tolerance=0.05)
    total_patterns = 0

    with Session(engine_db) as session:
        # Get instruments to scan
        if instrument_id:
            instruments = session.execute(
                text("SELECT id, symbol FROM instruments WHERE id = :id"),
                {"id": instrument_id},
            ).fetchall()
        else:
            instruments = session.execute(
                text("SELECT id, symbol FROM instruments WHERE is_active = TRUE")
            ).fetchall()

        for instr_id, symbol in instruments:
            # Fetch last 250 trading days
            rows = session.execute(
                text(
                    "SELECT time, open, high, low, close, volume FROM ohlcv_eod "
                    "WHERE instrument_id = :iid ORDER BY time DESC LIMIT 250"
                ),
                {"iid": instr_id},
            ).fetchall()

            if len(rows) < 30:
                continue

            df = pd.DataFrame(rows, columns=["time", "open", "high", "low", "close", "volume"])
            df = df.sort_values("time").reset_index(drop=True)
            df["open"] = df["open"].astype(float)
            df["high"] = df["high"].astype(float)
            df["low"] = df["low"].astype(float)
            df["close"] = df["close"].astype(float)
            df["volume"] = df["volume"].astype(float)

            patterns = pe.detect_all(df)
            
            # Debug logging
            highs = df["high"].values.astype(float)
            pivot_highs = pe._find_pivots(highs, is_high=True)
            logger.info(f"  🔍 {symbol}: {len(df)} rows, {len(pivot_highs)} pivot highs found")
            if patterns:
                logger.info(f"  ✓ {symbol}: Found {len(patterns)} patterns!")
            else:
                # Debug: check if pivots are found
                highs = df["high"].values.astype(float)
                lows = df["low"].values.astype(float)
                pivot_highs = pe._find_pivots(highs, is_high=True)
                pivot_lows = pe._find_pivots(lows, is_high=False)
                # logger.info(f"  - {symbol}: 0 patterns (Pivots: H={len(pivot_highs)}, L={len(pivot_lows)})")

            for p in patterns:
                key_points = {
                    "pivots": [
                        {"index": pv.index, "price": pv.price, "is_high": pv.is_high}
                        for pv in p.pivots
                    ]
                }
                import json
                session.execute(
                    text(
                        "INSERT INTO detected_patterns "
                        "(instrument_id, timeframe, pattern_type, status, confidence, "
                        "key_points, target_price, stop_loss, detection_time) "
                        "VALUES (:iid, 'D', :ptype, :status, :conf, :kp, :tp, :sl, :dt)"
                    ),
                    {
                        "iid": instr_id,
                        "ptype": p.pattern_type.value,
                        "status": p.status,
                        "conf": p.confidence,
                        "kp": json.dumps(key_points),
                        "tp": p.target_price,
                        "sl": p.stop_loss,
                        "dt": datetime.utcnow(),
                    },
                )
                total_patterns += 1

        session.commit()

    logger.info(f"Pattern scan complete: {total_patterns} patterns detected")
    return {"status": "ok", "patterns_found": total_patterns}


@celery_app.task(name="app.workers.tasks_eod.run_trendline_scan")
def run_trendline_scan(instrument_id: int = None):
    """Compute automated trendlines for instruments."""
    from app.services.trendline_engine import TrendlineEngine

    engine_db = _get_sync_engine()
    
    # We will use different engines/lookbacks for different timeframes
    # Monthly trendlines represent major macro support/resistance
    te_d = TrendlineEngine(pivot_lookback=5, touch_tolerance=0.005)
    te_w = TrendlineEngine(pivot_lookback=3, touch_tolerance=0.01)
    te_m = TrendlineEngine(pivot_lookback=2, touch_tolerance=0.015)
    
    total_trendlines = 0

    with Session(engine_db) as session:
        if instrument_id:
            instruments = session.execute(
                text("SELECT id, symbol FROM instruments WHERE id = :id"),
                {"id": instrument_id},
            ).fetchall()
        else:
            instruments = session.execute(
                text("SELECT id, symbol FROM instruments WHERE is_active = TRUE")
            ).fetchall()

        for instr_id, symbol in instruments:
            rows = session.execute(
                text(
                    "SELECT time, open, high, low, close, volume FROM ohlcv_eod "
                    "WHERE instrument_id = :iid ORDER BY time DESC LIMIT 1500"
                ),
                {"iid": instr_id},
            ).fetchall()

            if len(rows) < 30:
                continue

            df = pd.DataFrame(rows, columns=["time", "open", "high", "low", "close", "volume"])
            df = df.sort_values("time").reset_index(drop=True)
            df["time"] = pd.to_datetime(df["time"])
            for col in ["open", "high", "low", "close", "volume"]:
                df[col] = df[col].astype(float)
                
            # Deactivate old trendlines first
            session.execute(
                text("UPDATE trendlines SET is_active = FALSE WHERE instrument_id = :iid"),
                {"iid": instr_id},
            )
            
            # --- Daily ---
            tls_d = te_d.detect(df)
            for tl in tls_d:
                pa_time = df.iloc[tl.point_a_idx]["time"] if tl.point_a_idx < len(df) else None
                pb_time = df.iloc[tl.point_b_idx]["time"] if tl.point_b_idx < len(df) else None
                _insert_trendline(session, instr_id, "D", tl, pa_time, pb_time)
                total_trendlines += 1

            # --- Weekly ---
            df_w = df.set_index("time").resample("W-FRI").agg({
                "open": "first", "high": "max", "low": "min", "close": "last", "volume": "sum"
            }).dropna().reset_index()
            tls_w = te_w.detect(df_w)
            for tl in tls_w:
                pa_time = df_w.iloc[tl.point_a_idx]["time"] if tl.point_a_idx < len(df_w) else None
                pb_time = df_w.iloc[tl.point_b_idx]["time"] if tl.point_b_idx < len(df_w) else None
                _insert_trendline(session, instr_id, "W", tl, pa_time, pb_time)
                total_trendlines += 1

            # --- Monthly ---
            df_m = df.set_index("time").resample("ME").agg({
                "open": "first", "high": "max", "low": "min", "close": "last", "volume": "sum"
            }).dropna().reset_index()
            tls_m = te_m.detect(df_m)
            for tl in tls_m:
                pa_time = df_m.iloc[tl.point_a_idx]["time"] if tl.point_a_idx < len(df_m) else None
                pb_time = df_m.iloc[tl.point_b_idx]["time"] if tl.point_b_idx < len(df_m) else None
                _insert_trendline(session, instr_id, "M", tl, pa_time, pb_time)
                total_trendlines += 1

        session.commit()

    logger.info(f"Trendline scan complete: {total_trendlines} trendlines detected")
    return {"status": "ok", "trendlines_found": total_trendlines}

def _insert_trendline(session, instr_id, timeframe, tl, pa_time, pb_time):
    session.execute(
        text(
            "INSERT INTO trendlines "
            "(instrument_id, timeframe, line_type, slope, intercept, "
            "point_a_time, point_a_price, point_b_time, point_b_price, touches, is_active, created_at) "
            "VALUES (:iid, :tf, :lt, :slope, :intercept, :pa_t, :pa_p, :pb_t, :pb_p, :touches, 1, CURRENT_TIMESTAMP)"
        ),
        {
            "iid": int(instr_id),
            "tf": str(timeframe),
            "lt": str(tl.line_type),
            "slope": float(tl.slope),
            "intercept": float(tl.intercept),
            "pa_t": pa_time.to_pydatetime() if pd.notnull(pa_time) else None,
            "pa_p": float(tl.point_a_price),
            "pb_t": pb_time.to_pydatetime() if pd.notnull(pb_time) else None,
            "pb_p": float(tl.point_b_price),
            "touches": int(tl.touches),
        },
    )
