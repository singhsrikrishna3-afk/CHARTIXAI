"""PEESTOCK — Alembic env.py for async migrations."""

import os
from logging.config import fileConfig

from sqlalchemy import pool
from sqlalchemy.ext.asyncio import async_engine_from_config

from alembic import context

# Alembic Config object
config = context.config

# Override sqlalchemy.url from environment if available
db_url = os.environ.get("DATABASE_URL", "")
if db_url:
    # Ensure we use the async driver for online migrations
    db_url = db_url.replace("postgresql://", "postgresql+asyncpg://")
    if "+asyncpg" not in db_url:
        db_url = db_url.replace("postgresql", "postgresql+asyncpg", 1)
    config.set_main_option("sqlalchemy.url", db_url)

# Logging
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

# Import all models so Alembic sees them
from app.database import Base
from app.models import *  # noqa: F401, F403

target_metadata = Base.metadata


def run_migrations_offline():
    """Run migrations in 'offline' mode — emit SQL to stdout."""
    url = config.get_main_option("sqlalchemy.url")
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )
    with context.begin_transaction():
        context.run_migrations()


def do_run_migrations(connection):
    context.configure(connection=connection, target_metadata=target_metadata)
    with context.begin_transaction():
        context.run_migrations()


async def run_async_migrations():
    """Run migrations in 'online' mode using async engine."""
    connectable = async_engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    async with connectable.connect() as connection:
        await connection.run_sync(do_run_migrations)
    await connectable.dispose()


def run_migrations_online():
    import asyncio
    asyncio.run(run_async_migrations())


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
