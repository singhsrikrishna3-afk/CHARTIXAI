"""PEESTOCK — Intraday Data Tasks.

Processes intraday tick data, aggregates to 1-min OHLCV,
and resamples to higher timeframes.
"""

import logging
from datetime import datetime, timezone

import pandas as pd
from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session

from app.workers.celery_app import celery_app
from app.config import get_settings

logger = logging.getLogger(__name__)
settings = get_settings()

ALLOWED_SEGMENTS = {"EQ"}  # Only NSE cash equities
EXCLUDED_SEGMENTS = {"FUT", "OPT", "CDS", "MCX", "NCDEX", "CURRENCY"}

SYNC_DB_URL = settings.DATABASE_URL.replace("+asyncpg", "+psycopg2").replace(
    "postgresql+psycopg2", "postgresql"
)

RESAMPLE_MAP = {
    "5m": "5min",
    "15m": "15min",
    "1h": "1h",
    "4h": "4h",
}


def _get_sync_engine():
    kwargs = {}
    if SYNC_DB_URL.startswith("sqlite"):
        kwargs["connect_args"] = {"timeout": 30}
    return create_engine(SYNC_DB_URL, pool_pre_ping=True, **kwargs)


@celery_app.task(name="app.workers.tasks_intraday.ingest_intraday_tick")
def ingest_intraday_tick(data: dict):
    """Process a single intraday tick update.

    Filters out non-EQ segments. Only processes top N instruments.
    """
    segment = data.get("segment", "")
    if segment in EXCLUDED_SEGMENTS or segment not in ALLOWED_SEGMENTS:
        return {"skipped": True, "reason": f"segment {segment} not supported"}

    symbol = data.get("symbol")
    if not symbol:
        return {"skipped": True, "reason": "no symbol"}

    engine = _get_sync_engine()

    with Session(engine) as session:
        # Check if instrument is in top-N intraday list
        result = session.execute(
            text(
                "SELECT id FROM instruments "
                "WHERE symbol = :sym AND is_active = TRUE AND is_intraday = TRUE"
            ),
            {"sym": symbol},
        )
        instr = result.fetchone()
        if not instr:
            return {"skipped": True, "reason": f"{symbol} not in intraday list"}

        instrument_id = instr[0]
        tick_time = data.get("time", datetime.now(timezone.utc).isoformat())
        if isinstance(tick_time, str):
            tick_time = datetime.fromisoformat(tick_time)

        # Round to nearest minute
        tick_time = tick_time.replace(second=0, microsecond=0)

        if SYNC_DB_URL.startswith("sqlite"):
            query = (
                "INSERT INTO ohlcv_intraday (time, instrument_id, open, high, low, close, volume) "
                "VALUES (:t, :iid, :o, :h, :l, :c, :v) "
                "ON CONFLICT (instrument_id, time) DO UPDATE SET "
                "high = max(ohlcv_intraday.high, EXCLUDED.high), "
                "low = min(ohlcv_intraday.low, EXCLUDED.low), "
                "close = EXCLUDED.close, "
                "volume = ohlcv_intraday.volume + EXCLUDED.volume"
            )
        else:
            query = (
                "INSERT INTO ohlcv_intraday (time, instrument_id, open, high, low, close, volume) "
                "VALUES (:t, :iid, :o, :h, :l, :c, :v) "
                "ON CONFLICT (instrument_id, time) DO UPDATE SET "
                "high = GREATEST(ohlcv_intraday.high, EXCLUDED.high), "
                "low = LEAST(ohlcv_intraday.low, EXCLUDED.low), "
                "close = EXCLUDED.close, "
                "volume = ohlcv_intraday.volume + EXCLUDED.volume"
            )

        session.execute(
            text(query),
            {
                "t": tick_time,
                "iid": instrument_id,
                "o": float(data.get("open", data.get("price", 0))),
                "h": float(data.get("high", data.get("price", 0))),
                "l": float(data.get("low", data.get("price", 0))),
                "c": float(data.get("close", data.get("price", 0))),
                "v": int(data.get("volume", 0)),
            },
        )
        session.commit()

    return {"status": "ok", "symbol": symbol}


@celery_app.task(name="app.workers.tasks_intraday.resample_intraday")
def resample_intraday(instrument_id: int):
    """Resample 1-min bars to 5m, 15m, 1h, 4h after market hours."""
    engine = _get_sync_engine()

    with Session(engine) as session:
        # Get last 90 days of 1-min data
        rows = session.execute(
            text(
                "SELECT time, open, high, low, close, volume FROM ohlcv_intraday "
                "WHERE instrument_id = :iid "
                "ORDER BY time"
            ),
            {"iid": instrument_id},
        ).fetchall()

        if not rows:
            return {"status": "no_data", "instrument_id": instrument_id}

        df = pd.DataFrame(rows, columns=["time", "open", "high", "low", "close", "volume"])
        df["time"] = pd.to_datetime(df["time"])
        df = df.set_index("time")
        df = df.astype({"open": float, "high": float, "low": float, "close": float, "volume": float})

        for tf_label, pd_freq in RESAMPLE_MAP.items():
            resampled = df.resample(pd_freq).agg({
                "open": "first",
                "high": "max",
                "low": "min",
                "close": "last",
                "volume": "sum",
            }).dropna()

            for ts, row in resampled.iterrows():
                session.execute(
                    text(
                        "INSERT INTO ohlcv_resampled "
                        "(time, instrument_id, timeframe, open, high, low, close, volume) "
                        "VALUES (:t, :iid, :tf, :o, :h, :l, :c, :v) "
                        "ON CONFLICT (instrument_id, timeframe, time) DO UPDATE SET "
                        "open=EXCLUDED.open, high=EXCLUDED.high, low=EXCLUDED.low, "
                        "close=EXCLUDED.close, volume=EXCLUDED.volume"
                    ),
                    {
                        "t": ts,
                        "iid": instrument_id,
                        "tf": tf_label,
                        "o": float(row["open"]),
                        "h": float(row["high"]),
                        "l": float(row["low"]),
                        "c": float(row["close"]),
                        "v": int(row["volume"]),
                    },
                )

        session.commit()

    logger.info(f"Resampled intraday data for instrument {instrument_id}")
    return {"status": "ok", "instrument_id": instrument_id}
