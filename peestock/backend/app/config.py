"""PEESTOCK — Configuration."""

import os
from pydantic_settings import BaseSettings
from functools import lru_cache

# Base directory of the project (e.g. /Users/srikrishnasingh/AG1 BB/PEESTOCKS)
BASE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
DEFAULT_DB_PATH = os.path.join(BASE_DIR, "peestock.db")


class Settings(BaseSettings):
    # App
    APP_NAME: str = "PEESTOCK"
    DEBUG: bool = True

    # Database
    DATABASE_URL: str = f"sqlite:///{DEFAULT_DB_PATH}?timeout=30"

    # Redis
    REDIS_URL: str = "redis://localhost:6379/0"

    # JWT
    JWT_SECRET: str = "change-me-in-production"
    JWT_ALGORITHM: str = "HS256"
    JWT_EXPIRY_MINUTES: int = 1440

    # S3
    S3_BUCKET: str = "peestock-scans"
    S3_ENDPOINT: str = ""
    AWS_ACCESS_KEY_ID: str = ""
    AWS_SECRET_ACCESS_KEY: str = ""

    # Razorpay
    RAZORPAY_KEY_ID: str = ""
    RAZORPAY_KEY_SECRET: str = ""
    RAZORPAY_WEBHOOK_SECRET: str = ""

    # Data
    NSE_DATA_DIR: str = "./data/nse"
    INTRADAY_TOP_N: int = 400

    class Config:
        env_file = ".env"


@lru_cache()
def get_settings() -> Settings:
    return Settings()
