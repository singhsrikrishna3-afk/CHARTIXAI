"""PEESTOCK — Celery worker configuration."""

from celery import Celery
from app.config import get_settings

settings = get_settings()

celery_app = Celery(
    "peestock",
    broker=settings.REDIS_URL,
    backend=settings.REDIS_URL,
    include=[
        "app.workers.tasks_eod",
        "app.workers.tasks_forecast",
    ],
)

from celery.schedules import crontab

celery_app.conf.update(
    task_serializer="json",
    accept_content=["json"],
    result_serializer="json",
    timezone="Asia/Kolkata",
    enable_utc=True,
    task_track_started=True,
    beat_schedule={
        "eod-data-update": {
            "task": "app.workers.tasks_eod.ingest_eod_data",
            "schedule": crontab(hour=18, minute=30),  # 6:30 PM IST daily
        },
        "sector-data-update": {
            "task": "app.workers.tasks_eod.ingest_sector_data",
            "schedule": crontab(hour=19, minute=0, day_of_week=0),  # Sunday 7 PM IST
        },
        "forecast-weekly-retrain": {
            "task": "app.workers.tasks_forecast.retrain_forecast_model",
            "schedule": crontab(hour=20, minute=0, day_of_week=6),  # Saturday 8 PM IST
        },
        "forecast-daily-precompute": {
            "task": "app.workers.tasks_forecast.precompute_forecasts",
            "schedule": crontab(hour=19, minute=30),  # 7:30 PM IST daily
        },
        "fundamentals-nightly-refresh": {
            "task": "app.workers.tasks_eod.refresh_fundamentals",
            "schedule": crontab(hour=21, minute=0),  # 9 PM IST daily (after EOD jobs)
        },
    },
)
