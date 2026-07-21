"""initial schema

Revision ID: 0001
Revises:
Create Date: 2026-07-01
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "instruments",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("symbol", sa.String(20), nullable=False),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("exchange", sa.String(10), nullable=True),
        sa.Column("segment", sa.String(20), nullable=True),
        sa.Column("isin", sa.String(12), nullable=True),
        sa.Column("lot_size", sa.Integer(), nullable=True),
        sa.Column("is_active", sa.Boolean(), nullable=True),
        sa.Column("is_intraday", sa.Boolean(), nullable=True),
        sa.Column("sector", sa.String(100), nullable=True),
        sa.Column("industry", sa.String(100), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("symbol"),
    )
    op.create_index("ix_instruments_symbol", "instruments", ["symbol"])

    op.create_table(
        "index_constituents",
        sa.Column("index_id", sa.Integer(), nullable=False),
        sa.Column("instrument_id", sa.Integer(), nullable=False),
        sa.ForeignKeyConstraint(["index_id"], ["instruments.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["instrument_id"], ["instruments.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("index_id", "instrument_id"),
    )
    op.create_index("idx_idx_const_index", "index_constituents", ["index_id"])
    op.create_index("idx_idx_const_instr", "index_constituents", ["instrument_id"])

    op.create_table(
        "ohlcv_eod",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("instrument_id", sa.Integer(), nullable=False),
        sa.Column("time", sa.Date(), nullable=False),
        sa.Column("open", sa.Numeric(18, 4), nullable=True),
        sa.Column("high", sa.Numeric(18, 4), nullable=True),
        sa.Column("low", sa.Numeric(18, 4), nullable=True),
        sa.Column("close", sa.Numeric(18, 4), nullable=True),
        sa.Column("volume", sa.BigInteger(), nullable=True),
        sa.ForeignKeyConstraint(["instrument_id"], ["instruments.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("instrument_id", "time", name="uq_ohlcv_eod_instrument_time"),
    )
    op.create_index("ix_ohlcv_eod_instrument_time", "ohlcv_eod", ["instrument_id", "time"])

    op.create_table(
        "ohlcv_intraday",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("instrument_id", sa.Integer(), nullable=False),
        sa.Column("time", sa.DateTime(timezone=True), nullable=False),
        sa.Column("open", sa.Numeric(18, 4), nullable=True),
        sa.Column("high", sa.Numeric(18, 4), nullable=True),
        sa.Column("low", sa.Numeric(18, 4), nullable=True),
        sa.Column("close", sa.Numeric(18, 4), nullable=True),
        sa.Column("volume", sa.BigInteger(), nullable=True),
        sa.ForeignKeyConstraint(["instrument_id"], ["instruments.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("instrument_id", "time", name="uq_ohlcv_intraday_instrument_time"),
    )
    op.create_index("ix_ohlcv_intraday_instrument_time", "ohlcv_intraday", ["instrument_id", "time"])

    op.create_table(
        "ohlcv_resampled",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("instrument_id", sa.Integer(), nullable=False),
        sa.Column("timeframe", sa.String(10), nullable=False),
        sa.Column("time", sa.DateTime(timezone=True), nullable=False),
        sa.Column("open", sa.Numeric(18, 4), nullable=True),
        sa.Column("high", sa.Numeric(18, 4), nullable=True),
        sa.Column("low", sa.Numeric(18, 4), nullable=True),
        sa.Column("close", sa.Numeric(18, 4), nullable=True),
        sa.Column("volume", sa.BigInteger(), nullable=True),
        sa.ForeignKeyConstraint(["instrument_id"], ["instruments.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("instrument_id", "timeframe", "time", name="uq_ohlcv_resampled"),
    )
    op.create_index("ix_ohlcv_resampled_instrument_timeframe_time", "ohlcv_resampled",
                    ["instrument_id", "timeframe", "time"])

    op.create_table(
        "users",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("email", sa.String(255), nullable=False),
        sa.Column("hashed_password", sa.String(255), nullable=False),
        sa.Column("full_name", sa.String(100), nullable=True),
        sa.Column("is_active", sa.Boolean(), nullable=True),
        sa.Column("is_admin", sa.Boolean(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("email"),
    )
    op.create_index("ix_users_email", "users", ["email"])

    op.create_table(
        "subscriptions",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("tier", sa.String(20), nullable=True),
        sa.Column("status", sa.String(20), nullable=True),
        sa.Column("utr", sa.String(50), nullable=True),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )

    op.create_table(
        "detected_patterns",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("instrument_id", sa.Integer(), nullable=True),
        sa.Column("pattern_name", sa.String(100), nullable=True),
        sa.Column("timeframe", sa.String(10), nullable=True),
        sa.Column("detected_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("start_time", sa.DateTime(timezone=True), nullable=True),
        sa.Column("end_time", sa.DateTime(timezone=True), nullable=True),
        sa.Column("direction", sa.String(10), nullable=True),
        sa.Column("confidence", sa.Numeric(5, 2), nullable=True),
        sa.Column("key_points", sa.JSON(), nullable=True),
        sa.Column("is_active", sa.Boolean(), nullable=True),
        sa.ForeignKeyConstraint(["instrument_id"], ["instruments.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_detected_patterns_instrument_pattern", "detected_patterns",
                    ["instrument_id", "pattern_name"])

    op.create_table(
        "pattern_backtest_stats",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("instrument_id", sa.Integer(), nullable=True),
        sa.Column("pattern_name", sa.String(100), nullable=False),
        sa.Column("timeframe", sa.String(10), nullable=False),
        sa.Column("win_rate", sa.Numeric(5, 2), nullable=True),
        sa.Column("avg_gain_pct", sa.Numeric(8, 4), nullable=True),
        sa.Column("avg_loss_pct", sa.Numeric(8, 4), nullable=True),
        sa.Column("total_trades", sa.Integer(), nullable=True),
        sa.Column("last_updated", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["instrument_id"], ["instruments.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )

    op.create_table(
        "custom_scanners",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("name", sa.String(100), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("conditions", sa.JSON(), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )

    op.create_table(
        "trendlines",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("instrument_id", sa.Integer(), nullable=False),
        sa.Column("timeframe", sa.String(10), nullable=False),
        sa.Column("x1", sa.Integer(), nullable=False),
        sa.Column("y1", sa.Numeric(18, 4), nullable=False),
        sa.Column("x2", sa.Integer(), nullable=False),
        sa.Column("y2", sa.Numeric(18, 4), nullable=False),
        sa.Column("color", sa.String(20), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["instrument_id"], ["instruments.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )

    op.create_table(
        "watchlist_items",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("instrument_id", sa.Integer(), nullable=False),
        sa.Column("added_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["instrument_id"], ["instruments.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("user_id", "instrument_id", name="uq_watchlist_user_instrument"),
    )

    op.create_table(
        "portfolio_positions",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("instrument_id", sa.Integer(), nullable=False),
        sa.Column("quantity", sa.Numeric(18, 4), nullable=True),
        sa.Column("avg_price", sa.Numeric(18, 4), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["instrument_id"], ["instruments.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )

    op.create_table(
        "alert_rules",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("instrument_id", sa.Integer(), nullable=False),
        sa.Column("condition_type", sa.String(50), nullable=False),
        sa.Column("threshold", sa.Numeric(18, 4), nullable=True),
        sa.Column("is_active", sa.Boolean(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["instrument_id"], ["instruments.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )

    op.create_table(
        "triggered_alerts",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("alert_rule_id", sa.Integer(), nullable=True),
        sa.Column("instrument_id", sa.Integer(), nullable=False),
        sa.Column("message", sa.Text(), nullable=True),
        sa.Column("triggered_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["alert_rule_id"], ["alert_rules.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["instrument_id"], ["instruments.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )

    op.create_table(
        "forecasts",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("instrument_id", sa.Integer(), nullable=False),
        sa.Column("symbol", sa.String(20), nullable=False),
        sa.Column("model_version", sa.String(50), nullable=True),
        sa.Column("horizon_day", sa.Integer(), nullable=False),
        sa.Column("anchor_date", sa.Date(), nullable=True),
        sa.Column("anchor_price", sa.Numeric(18, 4), nullable=True),
        sa.Column("predicted_price", sa.Numeric(18, 4), nullable=True),
        sa.Column("lower_bound", sa.Numeric(18, 4), nullable=True),
        sa.Column("upper_bound", sa.Numeric(18, 4), nullable=True),
        sa.Column("predicted_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["instrument_id"], ["instruments.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("instrument_id", "horizon_day", name="uq_forecast_instrument_horizon"),
    )
    op.create_index("ix_forecasts_symbol", "forecasts", ["symbol"])

    op.create_table(
        "nse_holidays",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("date", sa.Date(), nullable=False),
        sa.Column("description", sa.String(200), nullable=True),
        sa.Column("exchange", sa.String(10), nullable=True),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("date", "exchange", name="uq_nse_holiday_date_exchange"),
    )


def downgrade() -> None:
    op.drop_table("nse_holidays")
    op.drop_table("forecasts")
    op.drop_table("triggered_alerts")
    op.drop_table("alert_rules")
    op.drop_table("portfolio_positions")
    op.drop_table("watchlist_items")
    op.drop_table("trendlines")
    op.drop_table("custom_scanners")
    op.drop_table("pattern_backtest_stats")
    op.drop_table("detected_patterns")
    op.drop_table("subscriptions")
    op.drop_table("users")
    op.drop_table("ohlcv_resampled")
    op.drop_table("ohlcv_intraday")
    op.drop_table("ohlcv_eod")
    op.drop_table("index_constituents")
    op.drop_table("instruments")
