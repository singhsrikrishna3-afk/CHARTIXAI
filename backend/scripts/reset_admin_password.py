"""Reset password(s) for one or more user emails directly in the database.

Usage:
    python scripts/reset_admin_password.py user@example.com [user2@example.com ...]

Prints a freshly generated password for each email found. Run from backend/
with the venv active so `app` is importable.
"""
import asyncio
import secrets
import sys
from typing import Optional

from sqlalchemy import select, update

from app.database import AsyncSessionLocal
from app.models.models import User
from app.auth import hash_password


async def reset_password(email: str) -> Optional[str]:
    async with AsyncSessionLocal() as session:
        result = await session.execute(select(User).where(User.email == email))
        user = result.scalar_one_or_none()
        if user is None:
            return None

        new_password = secrets.token_urlsafe(12)
        await session.execute(
            update(User).where(User.email == email).values(password_hash=hash_password(new_password))
        )
        await session.commit()
        return new_password


async def main(emails: list[str]) -> None:
    for email in emails:
        new_password = await reset_password(email)
        if new_password is None:
            print(f"✗ No user found with email: {email}")
        else:
            print(f"✓ {email} -> new password: {new_password}")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python scripts/reset_admin_password.py <email> [<email> ...]")
        sys.exit(1)
    asyncio.run(main(sys.argv[1:]))
