"""Shared UTC timestamp factory for durable domain entities."""
from datetime import datetime, timezone


def utc_now() -> datetime:
    return datetime.now(timezone.utc)
