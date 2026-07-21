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
    kwargs = {"echo": settings.DEBUG}
    if not db_url.startswith("sqlite"):
        kwargs["pool_size"] = 20
        kwargs["max_overflow"] = 10
    else:
        kwargs["connect_args"] = {"timeout": 30}
        
    engine = create_async_engine(db_url, **kwargs)
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
