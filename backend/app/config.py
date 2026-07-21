"""PEESTOCK — Configuration."""

import logging
import os
from pydantic_settings import BaseSettings
from functools import lru_cache

logger = logging.getLogger(__name__)

# Base directory of the project (e.g. /Users/srikrishnasingh/AG1 BB/PEESTOCKS)
BASE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
DEFAULT_DB_PATH = os.path.join(BASE_DIR, "peestock.db")

_INSECURE_JWT_SECRET = "change-me-in-production"


class Settings(BaseSettings):
    # App
    APP_NAME: str = "Chartix"
    DEBUG: bool = False

    # Database
    DATABASE_URL: str = f"sqlite:///{DEFAULT_DB_PATH}?timeout=30"

    # Redis
    REDIS_URL: str = "redis://localhost:6379/0"

    # JWT
    JWT_SECRET: str = _INSECURE_JWT_SECRET
    JWT_ALGORITHM: str = "HS256"
    JWT_EXPIRY_MINUTES: int = 1440

    # Telegram alert delivery (empty = feature off, alerts stay in-app only)
    TELEGRAM_BOT_TOKEN: str = ""
    TELEGRAM_BOT_USERNAME: str = ""

    # CORS — comma-separated list of allowed origins
    CORS_ORIGINS: str = "http://localhost:3000,http://localhost:3001,https://chartix-pi.vercel.app"

    # S3
    S3_BUCKET: str = "peestock-scans"
    S3_ENDPOINT: str = ""
    AWS_ACCESS_KEY_ID: str = ""
    AWS_SECRET_ACCESS_KEY: str = ""

    # AWS Bedrock — powers the AI assistant (Claude with tool-use over scans).
    # Disabled by default; the assistant falls back to the rule-based intent
    # router until BEDROCK_ENABLED=true and AWS creds with Bedrock model access
    # are present. AWS_REGION / creds reuse the AWS_* settings above.
    BEDROCK_ENABLED: bool = False
    AWS_REGION: str = "us-east-1"
    # Inference-profile / model id. Cross-region profiles are prefixed with the
    # region group, e.g. "us.anthropic.claude-sonnet-4-5-20250929-v1:0".
    BEDROCK_MODEL_ID: str = "us.anthropic.claude-sonnet-4-5-20250929-v1:0"
    BEDROCK_MAX_TOKENS: int = 1024
    BEDROCK_MAX_TOOL_TURNS: int = 5

    # Razorpay
    RAZORPAY_KEY_ID: str = ""
    RAZORPAY_KEY_SECRET: str = ""
    RAZORPAY_WEBHOOK_SECRET: str = ""

    # UPI
    UPI_ID: str = "peestocks@upi"
    UPI_NAME: str = "PeeStocks Technicals"

    # Data
    NSE_DATA_DIR: str = "./data/nse"
    INTRADAY_TOP_N: int = 400

    @property
    def cors_origins_list(self) -> list[str]:
        return [o.strip() for o in self.CORS_ORIGINS.split(",") if o.strip()]

    class Config:
        env_file = ".env"


@lru_cache()
def get_settings() -> Settings:
    s = Settings()
    if s.JWT_SECRET == _INSECURE_JWT_SECRET and not s.DEBUG:
        logger.warning(
            "SECURITY WARNING: JWT_SECRET is set to the insecure default value. "
            "Set JWT_SECRET in your .env file before going to production."
        )
    return s
