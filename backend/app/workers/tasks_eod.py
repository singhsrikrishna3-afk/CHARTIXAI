"""PEESTOCK — EOD Data Ingestion Tasks.

Handles bhavcopy download, pattern scanning, and trendline detection.
"""

import io
import json
import logging
from datetime import date, datetime, timedelta, timezone
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
    "https://nsearchives.nseindia.com/content/cm/"
    "BhavCopy_NSE_CM_0_0_0_{date}_F_0000.csv.zip"
)

NSE_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.5",
    "Referer": "https://www.nseindia.com/",
}


def _download_bhavcopy(target_date: date) -> Optional[pd.DataFrame]:
    """Download and parse NSE bhavcopy CSV for a given date."""
    date_str = target_date.strftime("%Y%m%d")

    url = NSE_BHAVCOPY_URL.format(date=date_str)
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

        # Filter only EQ series (cash equities, no F&O/bonds/SME)
        df = df[df["SctySrs"].isin(["EQ", "BE"])]
        df = df.rename(columns={
            "TckrSymb": "symbol",
            "OpnPric": "open",
            "HghPric": "high",
            "LwPric": "low",
            "ClsPric": "close",
            "TtlTradgVol": "volume",
            "TtlTrfVal": "turnover",
            "TradDt": "date",
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


def _ingest_bhavcopy_for_date(session: Session, dt: date) -> int:
    """Download + upsert the NSE bhavcopy (equities + indices) for one date.

    Returns the number of rows inserted/updated, or -1 if NSE had no data
    for that date at all (almost always means it was a trading holiday).
    """
    df = _download_bhavcopy(dt)
    idx_records = _download_index_data(dt)

    if (df is None or df.empty) and not idx_records:
        return -1

    inserted = 0

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
    return inserted


def run_daily_self_healing(session: Session, target_date: date):
    """Check for price anomalies (spikes/cliffs > 5%) in the newly ingested EOD data and repair them.

    Repair is vendor-free: split/bonus cliffs are rescaled in place using the
    instrument's own history (see scripts/clean_spikes_advanced.py), not by
    overwriting against a second data source.
    """
    logger.info(f"🔍 Running self-healing daily verification for {target_date}...")
    
    # Query to find active equities that had a day-to-day price change of >5% on target_date
    query = """
        SELECT instrument_id, symbol, segment
        FROM (
            SELECT 
                o.instrument_id,
                o.close,
                i.symbol,
                i.segment,
                (
                    SELECT close FROM ohlcv_eod 
                    WHERE instrument_id = o.instrument_id AND time < o.time 
                    ORDER BY time DESC LIMIT 1
                ) as prev_close
            FROM ohlcv_eod o
            JOIN instruments i ON o.instrument_id = i.id
            WHERE o.time = :target_date AND i.segment = 'EQ' AND i.is_active = 1
        )
        WHERE prev_close IS NOT NULL 
          AND close > 0.5 
          AND prev_close > 0.5 
          AND (close < 0.95 * prev_close OR close > 1.05 * prev_close)
    """
    
    try:
        anomalies = session.execute(text(query), {"target_date": target_date}).fetchall()
        
        if not anomalies:
            logger.info("✅ No daily price anomalies detected. Data is clean.")
            return
            
        logger.info(f"⚠️ Detected {len(anomalies)} price anomalies/movements >5% on {target_date}. Verifying and repairing against Yahoo Finance...")
        
        # Add scripts directory to path to import clean_spikes_advanced
        import sys
        import os
        scripts_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "scripts")
        if scripts_dir not in sys.path:
            sys.path.append(scripts_dir)
            
        from clean_spikes_advanced import repair_instrument, get_db_connection
        
        # Open connection for repair_instrument (which expects standard db connection)
        conn = get_db_connection()
        try:
            repaired_count = 0
            for row in anomalies:
                iid, symbol, segment = row
                logger.info(f"Repairing daily anomaly/corporate action for {symbol} (ID: {iid})...")
                success = repair_instrument(conn, iid, symbol, segment)
                if success:
                    repaired_count += 1
            logger.info(f"Daily self-healing complete. Repaired {repaired_count} instruments.")
        finally:
            conn.close()
            
    except Exception as e:
        logger.error(f"Error in daily self-healing pipeline: {e}")


@celery_app.task(name="app.workers.tasks_eod.ingest_eod_data", bind=True, max_retries=3)
def ingest_eod_data(self, target_date: str = None):
    """Fetch and store end-of-day OHLCV data for all active instruments.

    Runs after market hours. Also triggers pattern detection scan on
    updated data. For multi-day catch-up, see run_eod_catchup() below.
    """
    if target_date:
        dt = datetime.strptime(target_date, "%Y-%m-%d").date()
    else:
        dt = date.today()

    engine = _get_sync_engine()
    with Session(engine) as session:
        inserted = _ingest_bhavcopy_for_date(session, dt)
        
        if inserted >= 0:
            # Run self-healing daily verification to clean up any splits, dividends, or ETF glitches immediately
            try:
                run_daily_self_healing(session, dt)
            except Exception as ex:
                logger.error(f"Failed to execute daily self-healing: {ex}")

    if inserted < 0:
        return {"status": "no_data", "date": str(dt)}

    # Trigger pattern scan
    try:
        run_pattern_scan.delay()
        run_trendline_scan.delay()
        run_alert_check.delay()
    except Exception as e:
        logger.warning(f"Could not queue background scans (Redis down?): {e}")

    return {"status": "ok", "date": str(dt), "records": inserted}



# ── NSE Sector/Industry Classification ────────────────────────
# NSE's free per-index constituent CSVs include an "Industry" column;
# the plain equity listing master (EQUITY_L.csv) has no sector field at all.
# Nifty Total Market is the broadest free list NSE publishes without a login/API key.
NSE_SECTOR_LIST_URL = "https://nsearchives.nseindia.com/content/indices/ind_niftytotalmarket_list.csv"


@celery_app.task(name="app.workers.tasks_eod.ingest_sector_data")
def ingest_sector_data():
    """Populate Instrument.sector from NSE's official Nifty Total Market constituent list.

    NSE's free CSV only exposes one classification tier ("Industry", e.g.
    "Financial Services", "Capital Goods") — there's no finer sub-industry
    breakdown without a paid feed, so we map it to our `sector` column only.
    Covers large/mid/small-cap index constituents; thinly-traded stocks
    outside any index are left unclassified.
    """
    try:
        with httpx.Client(timeout=30, follow_redirects=True) as client:
            client.get("https://www.nseindia.com/", headers=NSE_HEADERS)
            resp = client.get(NSE_SECTOR_LIST_URL, headers=NSE_HEADERS)
            resp.raise_for_status()
        df = pd.read_csv(io.BytesIO(resp.content))
    except Exception as e:
        logger.error(f"Sector list download failed: {e}")
        return {"status": "error", "detail": str(e)}

    df = df.rename(columns={"Symbol": "symbol", "Industry": "sector"})
    updated = 0

    engine_db = _get_sync_engine()
    with Session(engine_db) as session:
        for _, row in df.iterrows():
            result = session.execute(
                text("UPDATE instruments SET sector = :sector WHERE symbol = :symbol"),
                {"sector": row["sector"], "symbol": row["symbol"]},
            )
            updated += result.rowcount
        session.commit()

    logger.info(f"Sector ingestion complete: {updated} instruments updated")
    return {"status": "ok", "updated": updated}


ALERT_COOLDOWN_DAYS = 5


@celery_app.task(name="app.workers.tasks_eod.run_alert_check")
def run_alert_check():
    """Evaluate active alert rules and create in-app notifications for any that fire.

    Price alerts are one-shot: the rule is deactivated once it fires.
    Pattern alerts are recurring, but deduped via a cooldown window — each
    pattern scan rewrites detected_patterns with a fresh detection_time even
    for a pattern that has been forming for weeks, so detection_time alone
    can't tell us whether a pattern is "new".
    """
    from app.models.models import AlertRule, TriggeredAlert, DetectedPattern, Instrument

    engine_db = _get_sync_engine()
    triggered_count = 0

    with Session(engine_db) as session:
        # ── Price alerts (one-shot) ──
        price_rules = session.execute(
            select(AlertRule).where(
                AlertRule.is_active == True,
                AlertRule.alert_type.in_(["price_above", "price_below"]),
            )
        ).scalars().all()

        for rule in price_rules:
            row = session.execute(
                text(
                    "SELECT close FROM ohlcv_eod WHERE instrument_id = :iid "
                    "AND close IS NOT NULL ORDER BY time DESC LIMIT 1"
                ),
                {"iid": rule.instrument_id},
            ).fetchone()
            if not row or row[0] is None:
                continue

            price = float(row[0])
            target = float(rule.target_price)
            fired = (
                (rule.alert_type == "price_above" and price >= target)
                or (rule.alert_type == "price_below" and price <= target)
            )
            if not fired:
                continue

            inst = session.get(Instrument, rule.instrument_id)
            direction = "risen above" if rule.alert_type == "price_above" else "fallen below"
            session.add(TriggeredAlert(
                alert_rule_id=rule.id,
                user_id=rule.user_id,
                instrument_id=rule.instrument_id,
                message=f"{inst.symbol} has {direction} ₹{target:.2f} (current: ₹{price:.2f})",
            ))
            rule.is_active = False
            triggered_count += 1

        # ── Pattern alerts (recurring, cooldown-deduped) ──
        pattern_rules = session.execute(
            select(AlertRule).where(
                AlertRule.is_active == True,
                AlertRule.alert_type == "pattern",
            )
        ).scalars().all()

        cooldown_cutoff = datetime.utcnow() - timedelta(days=ALERT_COOLDOWN_DAYS)

        for rule in pattern_rules:
            q = select(DetectedPattern)
            if rule.instrument_id is not None:
                q = q.where(DetectedPattern.instrument_id == rule.instrument_id)
            if rule.pattern_type:
                q = q.where(DetectedPattern.pattern_type == rule.pattern_type)
            detected = session.execute(q).scalars().all()

            for pat in detected:
                already_notified = session.execute(
                    select(TriggeredAlert).where(
                        TriggeredAlert.alert_rule_id == rule.id,
                        TriggeredAlert.instrument_id == pat.instrument_id,
                        TriggeredAlert.pattern_type == pat.pattern_type,
                        TriggeredAlert.triggered_at >= cooldown_cutoff,
                    )
                ).scalar_one_or_none()
                if already_notified:
                    continue

                inst = session.get(Instrument, pat.instrument_id)
                pretty_pattern = pat.pattern_type.replace("_", " ").title()
                session.add(TriggeredAlert(
                    alert_rule_id=rule.id,
                    user_id=rule.user_id,
                    instrument_id=pat.instrument_id,
                    pattern_type=pat.pattern_type,
                    message=f"{inst.symbol}: {pretty_pattern} pattern detected",
                ))
                triggered_count += 1

        session.commit()

    logger.info(f"Alert check complete: {triggered_count} new notifications")
    return {"status": "ok", "triggered": triggered_count}


def run_eod_catchup(max_days: int = 30) -> dict:
    """Fill in every trading day missed since the last stored EOD date,
    using the real NSE bhavcopy feed (not Yahoo Finance) — covers cases
    where the daily scheduled ingest didn't run for one or more days.

    Runs the pattern/trendline scan once at the end, not per-day.
    """
    engine = _get_sync_engine()
    with Session(engine) as session:
        last_date = session.execute(text("SELECT MAX(time) FROM ohlcv_eod")).scalar()

    if last_date is None:
        start = date.today() - timedelta(days=max_days)
    else:
        if isinstance(last_date, str):
            last_date = datetime.strptime(last_date, "%Y-%m-%d").date()
        # Start from last_date (inclusive) to allow backfilling index files or late-published daily data
        start = last_date

    today = date.today()
    candidate_days = []
    d = start
    while d <= today:
        if d.weekday() < 5:  # Mon-Fri only; NSE holidays are handled by the no-data check
            candidate_days.append(d)
        d += timedelta(days=1)
    candidate_days = candidate_days[-max_days:]

    results = {}
    with Session(engine) as session:
        for d in candidate_days:
            inserted = _ingest_bhavcopy_for_date(session, d)
            results[str(d)] = inserted
            if inserted < 0:
                logger.info(f"EOD catchup {d}: no data (likely a trading holiday)")
            else:
                logger.info(f"EOD catchup {d}: {inserted} records")

    total = sum(v for v in results.values() if v > 0)
    days_with_data = [d for d, v in results.items() if v > 0]

    if days_with_data:
        run_pattern_scan()
        run_trendline_scan()
        run_alert_check()

    return {
        "status": "ok",
        "days_checked": list(results.keys()),
        "days_with_data": days_with_data,
        "total_records": total,
    }


@celery_app.task(name="app.workers.tasks_eod.run_pattern_scan")
def run_pattern_scan(instrument_id: int = None):
    """Run pattern detection engine on EOD data across Daily, Weekly, and Monthly timeframes.

    If instrument_id is None, scans all active instruments.
    """
    from app.services.pattern_engine import PatternEngine
    from app.services.backtest_engine import fit_tier, MIN_SAMPLE_SIZE

    engine_db = _get_sync_engine()
    pe = PatternEngine(pivot_lookback=3, tolerance=0.035)  # 5% called two tops 5% apart a "double top" — far too loose for daily charts
    total_patterns = 0

    with Session(engine_db) as session:
        # Empirical win-rate stats, keyed by (pattern_type, fit_tier). Loaded
        # once per scan run since the table is tiny (one row per bucket).
        # Patterns whose bucket isn't backtested yet (or has too few
        # historical samples) keep the geometric-fit confidence instead.
        backtest_stats: dict[tuple[str, str], dict] = {}
        try:
            for row in session.execute(text(
                "SELECT pattern_type, fit_tier, win_rate, sample_size FROM pattern_backtest_stats"
            )).fetchall():
                backtest_stats[(row[0], row[1])] = {"win_rate": float(row[2]) if row[2] is not None else None, "sample_size": row[3]}
        except Exception:
            pass  # table not created yet (backtest never run) — fine, fall back to geometric fit

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
            # Fetch last 1500 trading days to have enough history for weekly/monthly resamples
            rows = session.execute(
                text(
                    "SELECT time, open, high, low, close, volume FROM ohlcv_eod "
                    "WHERE instrument_id = :iid ORDER BY time DESC LIMIT 1500"
                ),
                {"iid": instr_id},
            ).fetchall()

            if len(rows) < 30:
                continue

            df_base = pd.DataFrame(rows, columns=["time", "open", "high", "low", "close", "volume"])
            df_base = df_base.sort_values("time").reset_index(drop=True)
            df_base["time"] = pd.to_datetime(df_base["time"])
            for col in ["open", "high", "low", "close", "volume"]:
                df_base[col] = df_base[col].astype(float)

            # Daily (last 300 bars)
            df_d = df_base.tail(300).reset_index(drop=True)

            # Weekly resampling
            df_w = df_base.set_index("time").resample("W-FRI").agg({
                "open": "first", "high": "max", "low": "min", "close": "last", "volume": "sum"
            }).dropna().reset_index()

            # Monthly resampling
            df_m = df_base.set_index("time").resample("ME").agg({
                "open": "first", "high": "max", "low": "min", "close": "last", "volume": "sum"
            }).dropna().reset_index()

            timeframes = [
                ("D", df_d),
                ("W", df_w),
                ("M", df_m)
            ]

            for tf, df_tf in timeframes:
                if len(df_tf) < 30:
                    # Clear out old patterns for this timeframe
                    session.execute(
                        text("DELETE FROM detected_patterns WHERE instrument_id = :iid AND timeframe = :tf"),
                        {"iid": instr_id, "tf": tf},
                    )
                    continue

                patterns = pe.detect_all(df_tf)

                # Upsert patterns for this instrument and timeframe
                existing_rows = session.execute(
                    text(
                        "SELECT id, pattern_type, key_points FROM detected_patterns "
                        "WHERE instrument_id = :iid AND timeframe = :tf"
                    ),
                    {"iid": instr_id, "tf": tf},
                ).fetchall()
                
                existing_by_key = {}
                for row_id, ptype, kp_raw in existing_rows:
                    kp = json.loads(kp_raw) if isinstance(kp_raw, str) else kp_raw
                    times = [pv["time"] for pv in (kp.get("pivots") or []) if pv.get("time")]
                    if times:
                        existing_by_key[(ptype, min(times), max(times))] = row_id

                matched_ids = set()
                for p in patterns:
                    # Prefer an empirical historical win rate over the geometric-fit
                    # blend whenever this pattern type + fit tier has been backtested
                    # with enough samples — that's a real measured outcome, not a
                    # heuristic about how clean the shape looks.
                    tier = fit_tier(p.confidence_breakdown)
                    stat = backtest_stats.get((p.pattern_type.value, tier))
                    if stat and stat["sample_size"] >= MIN_SAMPLE_SIZE and stat["win_rate"] is not None:
                        confidence = stat["win_rate"]
                        breakdown = {
                            "historical_win_rate": stat["win_rate"],
                            "sample_size": stat["sample_size"],
                        }
                        confidence_source = "backtested"
                    else:
                        confidence = p.confidence
                        breakdown = p.confidence_breakdown
                        confidence_source = "geometric_fit"

                    key_points = {
                        "pivots": [
                            {
                                "index": pv.index,
                                "price": pv.price,
                                "is_high": pv.is_high,
                                "time": pd.Timestamp(pv.time).strftime("%Y-%m-%d") if pv.time is not None else None,
                            }
                            for pv in p.pivots
                        ],
                        # Named sub-scores behind the headline confidence number, so the
                        # UI can explain *why* a pattern scored what it did instead of
                        # showing an opaque percentage.
                        "confidence_breakdown": breakdown,
                        "confidence_source": confidence_source,
                    }
                    pivot_times = [pt["time"] for pt in key_points["pivots"] if pt["time"]]
                    key = (p.pattern_type.value, min(pivot_times), max(pivot_times)) if pivot_times else None
                    existing_id = existing_by_key.get(key) if key else None
                    params = {
                        "iid": instr_id,
                        "tf": tf,
                        "ptype": p.pattern_type.value,
                        "status": p.status,
                        "conf": confidence,
                        "kp": json.dumps(key_points),
                        "tp": p.target_price,
                        "sl": p.stop_loss,
                        "dt": datetime.utcnow(),
                    }

                    if existing_id is not None:
                        matched_ids.add(existing_id)
                        params["id"] = existing_id
                        session.execute(
                            text(
                                "UPDATE detected_patterns SET status = :status, confidence = :conf, "
                                "key_points = :kp, target_price = :tp, stop_loss = :sl, detection_time = :dt "
                                "WHERE id = :id"
                            ),
                            params,
                        )
                    else:
                        session.execute(
                            text(
                                "INSERT INTO detected_patterns "
                                "(instrument_id, timeframe, pattern_type, status, confidence, "
                                "key_points, target_price, stop_loss, detection_time) "
                                "VALUES (:iid, :tf, :ptype, :status, :conf, :kp, :tp, :sl, :dt)"
                            ),
                            params,
                        )
                    total_patterns += 1

                # Patterns not redetected this run no longer hold — drop them.
                for row_id in existing_by_key.values():
                    if row_id not in matched_ids:
                        session.execute(
                            text("DELETE FROM detected_patterns WHERE id = :id"),
                            {"id": row_id},
                        )

        session.commit()

    logger.info(f"Pattern scan complete: {total_patterns} patterns detected")
    return {"status": "ok", "patterns_found": total_patterns}


@celery_app.task(name="app.workers.tasks_eod.run_pattern_backtest")
def run_pattern_backtest(instrument_id: int = None, max_instruments: int = None):
    """Recompute empirical win-rate stats per (pattern_type, fit_tier) bucket.

    Walks every historical instance of a backtestable pattern type (see
    app.services.backtest_engine) forward to its actual outcome — did price
    hit the pattern's target before its stop-loss — across each
    instrument's full EOD history. This is a heavier batch job than the
    live pattern scan (full history vs. last ~300 bars) so it's meant to
    run periodically (e.g. weekly), not on every ingest tick.

    run_pattern_scan() picks up the resulting stats automatically on its
    next run — it reads pattern_backtest_stats and prefers a backtested
    win rate over the geometric-fit confidence wherever the sample size is
    large enough.
    """
    from app.services.pattern_engine import PatternEngine
    from app.services.backtest_engine import backtest_instrument, aggregate_outcomes
    from app.models.models import PatternBacktestStat
    from app.database import Base

    engine_db = _get_sync_engine()
    Base.metadata.create_all(engine_db, tables=[PatternBacktestStat.__table__], checkfirst=True)

    pe = PatternEngine(pivot_lookback=3, tolerance=0.035)  # 5% called two tops 5% apart a "double top" — far too loose for daily charts
    all_outcomes = []

    with Session(engine_db) as session:
        if instrument_id:
            instruments = session.execute(
                text("SELECT id, symbol FROM instruments WHERE id = :id"),
                {"id": instrument_id},
            ).fetchall()
        else:
            query = "SELECT id, symbol FROM instruments WHERE is_active = TRUE"
            if max_instruments:
                query += f" LIMIT {int(max_instruments)}"
            instruments = session.execute(text(query)).fetchall()

        for instr_id, symbol in instruments:
            rows = session.execute(
                text(
                    "SELECT time, open, high, low, close, volume FROM ohlcv_eod "
                    "WHERE instrument_id = :iid ORDER BY time ASC LIMIT 5000"
                ),
                {"iid": instr_id},
            ).fetchall()
            if len(rows) < 30:
                continue

            df = pd.DataFrame(rows, columns=["time", "open", "high", "low", "close", "volume"])
            for col in ["open", "high", "low", "close", "volume"]:
                df[col] = df[col].astype(float)

            try:
                all_outcomes.extend(backtest_instrument(df, pe))
            except Exception as e:
                logger.warning(f"Backtest failed for {symbol} (ID: {instr_id}): {e}")

        agg = aggregate_outcomes(all_outcomes)
        now = datetime.utcnow()
        for (pattern_type, tier), stats in agg.items():
            session.execute(
                text(
                    "INSERT INTO pattern_backtest_stats "
                    "(pattern_type, fit_tier, wins, losses, win_rate, sample_size, updated_at) "
                    "VALUES (:pt, :tier, :wins, :losses, :wr, :n, :dt) "
                    "ON CONFLICT (pattern_type, fit_tier) DO UPDATE SET "
                    "wins = EXCLUDED.wins, losses = EXCLUDED.losses, win_rate = EXCLUDED.win_rate, "
                    "sample_size = EXCLUDED.sample_size, updated_at = EXCLUDED.updated_at"
                ),
                {
                    "pt": pattern_type, "tier": tier,
                    "wins": stats["wins"], "losses": stats["losses"],
                    "wr": stats["win_rate"], "n": stats["sample_size"], "dt": now,
                },
            )
        session.commit()

    logger.info(f"Pattern backtest complete: {len(all_outcomes)} outcomes scored across {len(agg)} buckets")
    return {"status": "ok", "outcomes_scored": len(all_outcomes), "buckets": len(agg)}


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


@celery_app.task(name="app.workers.tasks_eod.refresh_fundamentals")
def refresh_fundamentals():
    """Nightly refresh of the fundamentals table (full EQ universe)."""
    from app.services.fundamentals_ingest import run_sync
    result = run_sync(limit=None)
    logger.info("fundamentals refresh: %s", result)
    return result
