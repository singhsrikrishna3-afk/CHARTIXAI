-- PEESTOCK Database Initialization
-- Run inside TimescaleDB (PostgreSQL 16 + TimescaleDB extension)

CREATE EXTENSION IF NOT EXISTS timescaledb;
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
-- INSTRUMENTS
-- ============================================================
CREATE TABLE instruments (
    id              SERIAL PRIMARY KEY,
    symbol          VARCHAR(20) NOT NULL UNIQUE,
    name            VARCHAR(200) NOT NULL,
    exchange        VARCHAR(10) DEFAULT 'NSE',
    segment         VARCHAR(20) DEFAULT 'EQ',
    isin            VARCHAR(12),
    lot_size        INT DEFAULT 1,
    is_active       BOOLEAN DEFAULT TRUE,
    is_intraday     BOOLEAN DEFAULT FALSE,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- OHLCV — End of Day
-- ============================================================
CREATE TABLE ohlcv_eod (
    time            DATE NOT NULL,
    instrument_id   INT NOT NULL REFERENCES instruments(id),
    open            NUMERIC(12,2),
    high            NUMERIC(12,2),
    low             NUMERIC(12,2),
    close           NUMERIC(12,2),
    volume          BIGINT,
    delivery_qty    BIGINT,
    PRIMARY KEY (instrument_id, time)
);
SELECT create_hypertable('ohlcv_eod', 'time');

-- ============================================================
-- OHLCV — Intraday 1-min bars
-- ============================================================
CREATE TABLE ohlcv_intraday (
    time            TIMESTAMPTZ NOT NULL,
    instrument_id   INT NOT NULL REFERENCES instruments(id),
    open            NUMERIC(12,2),
    high            NUMERIC(12,2),
    low             NUMERIC(12,2),
    close           NUMERIC(12,2),
    volume          BIGINT,
    PRIMARY KEY (instrument_id, time)
);
SELECT create_hypertable('ohlcv_intraday', 'time');

-- Retention policy: keep 90 days of 1-min data
SELECT add_retention_policy('ohlcv_intraday', INTERVAL '90 days');

-- ============================================================
-- OHLCV — Resampled (5m, 15m, 1h, 4h, W, M)
-- ============================================================
CREATE TABLE ohlcv_resampled (
    time            TIMESTAMPTZ NOT NULL,
    instrument_id   INT NOT NULL REFERENCES instruments(id),
    timeframe       VARCHAR(5) NOT NULL,
    open            NUMERIC(12,2),
    high            NUMERIC(12,2),
    low             NUMERIC(12,2),
    close           NUMERIC(12,2),
    volume          BIGINT,
    PRIMARY KEY (instrument_id, timeframe, time)
);
SELECT create_hypertable('ohlcv_resampled', 'time');

-- ============================================================
-- USERS & AUTH
-- ============================================================
CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email           VARCHAR(255) NOT NULL UNIQUE,
    password_hash   VARCHAR(255) NOT NULL,
    full_name       VARCHAR(100),
    phone           VARCHAR(15),
    is_active       BOOLEAN DEFAULT TRUE,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- SUBSCRIPTIONS
-- ============================================================
CREATE TYPE sub_tier AS ENUM ('free','eod_basic','eod_pro','intraday','intraday_pro');
CREATE TYPE sub_status AS ENUM ('active','expired','cancelled','trial');

CREATE TABLE subscriptions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    tier            sub_tier NOT NULL DEFAULT 'free',
    status          sub_status NOT NULL DEFAULT 'trial',
    starts_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at      TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '14 days'),
    razorpay_sub_id VARCHAR(100),
    created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_sub_user ON subscriptions(user_id);

-- ============================================================
-- DETECTED PATTERNS
-- ============================================================
CREATE TABLE detected_patterns (
    id              BIGSERIAL PRIMARY KEY,
    instrument_id   INT NOT NULL REFERENCES instruments(id),
    timeframe       VARCHAR(5) NOT NULL,
    pattern_type    VARCHAR(50) NOT NULL,
    status          VARCHAR(20) DEFAULT 'forming',
    confidence      NUMERIC(5,2),
    detection_time  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    key_points      JSONB,
    target_price    NUMERIC(12,2),
    stop_loss       NUMERIC(12,2),
    image_url       TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_pat_instr ON detected_patterns(instrument_id, detection_time DESC);
CREATE INDEX idx_pat_type  ON detected_patterns(pattern_type, status);

-- ============================================================
-- CUSTOM SCANNERS (no-code)
-- ============================================================
CREATE TABLE custom_scanners (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name            VARCHAR(100) NOT NULL,
    description     TEXT,
    conditions      JSONB NOT NULL,
    is_public       BOOLEAN DEFAULT FALSE,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- TRENDLINES
-- ============================================================
CREATE TABLE trendlines (
    id              BIGSERIAL PRIMARY KEY,
    instrument_id   INT NOT NULL REFERENCES instruments(id),
    timeframe       VARCHAR(5) NOT NULL,
    line_type       VARCHAR(20),
    slope           NUMERIC(10,6),
    intercept       NUMERIC(12,2),
    point_a_time    TIMESTAMPTZ,
    point_a_price   NUMERIC(12,2),
    point_b_time    TIMESTAMPTZ,
    point_b_price   NUMERIC(12,2),
    touches         INT DEFAULT 2,
    is_active       BOOLEAN DEFAULT TRUE,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_tl_instr ON trendlines(instrument_id, is_active);
