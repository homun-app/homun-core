"""SSE helpers for interruptible interpret streaming (F3.5 slice C)."""

from __future__ import annotations

import json
from collections.abc import Iterator
from typing import Any


def sse_event(event: str, data: dict[str, Any]) -> str:
    payload = json.dumps(data, ensure_ascii=False)
    return f"event: {event}\ndata: {payload}\n\n"


def chunk_text(text: str, *, size: int = 24) -> list[str]:
    cleaned = text.strip()
    if not cleaned:
        return []
    return [cleaned[i : i + size] for i in range(0, len(cleaned), size)]


def iter_display_tokens(display: str, *, size: int = 24) -> Iterator[str]:
    for piece in chunk_text(display, size=size):
        yield piece
