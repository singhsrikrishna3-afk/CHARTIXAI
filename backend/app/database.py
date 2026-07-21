"""PEESTOCK — Database engine & session factory."""

from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker, AsyncSession
from sqlalchemy.orm import DeclarativeBase
from app.config import get_settings

settings = get_settings()

db_url = settings.DATABASE_URL
if db_url.startswith("sqlite") and "+aiosqlite" not in db_url:
    db_url = db_url.replace("sqlite://", "sqlite+aiosqlite://")

# We'll try to create the engine only when needed or handle the error
try:
    kwargs = {"echo": settings.DEBUG, "pool_pre_ping": True}
    if not db_url.startswith("sqlite"):
        kwargs["pool_size"] = 20
        kwargs["max_overflow"] = 40
    else:
        kwargs["connect_args"] = {"timeout": 60, "check_same_thread": False}

    engine = create_async_engine(db_url, **kwargs)

    if db_url.startswith("sqlite"):
        from sqlalchemy import event
        @event.listens_for(engine.sync_engine, "connect")
        def set_sqlite_pragma(dbapi_connection, connection_record):
            cursor = dbapi_connection.cursor()
            cursor.execute("PRAGMA journal_mode=WAL;")
            cursor.execute("PRAGMA busy_timeout=60000;")
            cursor.close()
except Exception as e:
    # Fallback for sync scripts that just need to import the Base
    print(f"Failed to create async engine: {e}")
    engine = None

async_engine = engine  # Alias for explicit imports

AsyncSessionLocal = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


async def get_db() -> AsyncSession:
    """FastAPI dependency — yields an async DB session."""
    async with AsyncSessionLocal() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise
