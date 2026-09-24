"""Result caching for web_search and web_extract with TTL and query normalization.

Derived from Hermes tools/web_result_cache.py (MIT). Homun keeps cached items in
memory with thread-safe access and TTL expiration.
"""
from __future__ import annotations

import re
import threading
import time
from urllib.parse import urlsplit

DEFAULT_TTL_SECONDS = 1200.0  # 20 minutes


def normalize_query(query: str) -> str:
    """Case-fold and collapse whitespace."""
    return re.sub(r"\s+", " ", (query or "").strip().lower())


def normalize_url(url: str) -> str:
    """Normalize public URL for cache indexing."""
    parsed = urlsplit(url.strip())
    scheme = parsed.scheme.lower()
    host = (parsed.hostname or "").lower()
    port = f":{parsed.port}" if parsed.port and (parsed.port != 80 if scheme == "http" else parsed.port != 443) else ""
    path = parsed.path or "/"
    query = f"?{parsed.query}" if parsed.query else ""
    return f"{scheme}://{host}{port}{path}{query}"


class WebCache:
    def __init__(self, ttl_seconds: float = DEFAULT_TTL_SECONDS):
        self.ttl = ttl_seconds
        self._search_store: dict[tuple[str, str], tuple[float, dict]] = {}
        self._extract_store: dict[str, tuple[float, dict]] = {}
        self._lock = threading.Lock()

    def get_search(self, provider: str, query: str) -> dict | None:
        key = (provider, normalize_query(query))
        with self._lock:
            entry = self._search_store.get(key)
            if entry is None:
                return None
            expires_at, response = entry
            if time.monotonic() >= expires_at:
                self._search_store.pop(key, None)
                return None
            return dict(response)

    def put_search(self, provider: str, query: str, response: dict) -> None:
        if "error_code" in response:
            return
        key = (provider, normalize_query(query))
        with self._lock:
            self._search_store[key] = (time.monotonic() + self.ttl, dict(response))

    def get_extract(self, url: str) -> dict | None:
        key = normalize_url(url)
        with self._lock:
            entry = self._extract_store.get(key)
            if entry is None:
                return None
            expires_at, response = entry
            if time.monotonic() >= expires_at:
                self._extract_store.pop(key, None)
                return None
            return dict(response)

    def put_extract(self, url: str, response: dict) -> None:
        if "error_code" in response:
            return
        key = normalize_url(url)
        with self._lock:
            self._extract_store[key] = (time.monotonic() + self.ttl, dict(response))

    def clear(self) -> None:
        with self._lock:
            self._search_store.clear()
            self._extract_store.clear()


GLOBAL_WEB_CACHE = WebCache()


def cached_fetch_page(url: str, cache: WebCache | None = None) -> dict:
    from homun.execution.web_pages import PageRefusal, _classify, fetch_page

    try:
        _classify(url)
    except PageRefusal as exc:
        return {"error_code": exc.code, "message": exc.message}
    c = cache or GLOBAL_WEB_CACHE
    hit = c.get_extract(url)
    if hit is not None:
        return {**hit, "cached": True}
    res = fetch_page(url)
    if "error_code" not in res:
        c.put_extract(url, res)
    return res
