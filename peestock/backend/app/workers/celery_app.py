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
        "app.workers.tasks_intraday",
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
    },
)
