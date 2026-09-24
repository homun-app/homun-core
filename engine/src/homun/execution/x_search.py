"""X Search tool backed by xAI API.

Derived from Hermes tools/x_search_tool.py (MIT).
Validates queries, date filters, and handles client-side. Requires explicit
XAI_API_KEY in the environment.
"""
from __future__ import annotations

import json
import os
import urllib.request
import urllib.error
from datetime import datetime

MAX_HANDLES = 10


def _parse_iso_date(value: str | None, field_name: str) -> str | None:
    if not value or not value.strip():
        return None
    raw = value.strip()
    try:
        dt = datetime.strptime(raw, "%Y-%m-%d")
        return dt.strftime("%Y-%m-%d")
    except ValueError:
        raise ValueError(f"{field_name} must be in YYYY-MM-DD format (got {raw!r})")


def search_x(
    query: str,
    allowed_handles: list[str] | None = None,
    excluded_handles: list[str] | None = None,
    from_date: str | None = None,
    to_date: str | None = None,
) -> dict:
    """Search public posts and profiles on X."""
    if not isinstance(query, str) or not query.strip() or len(query) > 500 or "\n" in query or "\r" in query:
        return {"error_code": "web_query_refused", "message": "The search query is empty or not a single line"}
    if allowed_handles and len(allowed_handles) > MAX_HANDLES:
        return {"error_code": "web_query_refused", "message": f"allowed_x_handles supports at most {MAX_HANDLES} handles"}
    if excluded_handles and len(excluded_handles) > MAX_HANDLES:
        return {"error_code": "web_query_refused", "message": f"excluded_x_handles supports at most {MAX_HANDLES} handles"}
    try:
        from_d = _parse_iso_date(from_date, "from_date")
        to_d = _parse_iso_date(to_date, "to_date")
    except ValueError as exc:
        return {"error_code": "web_query_refused", "message": str(exc)}

    api_key = os.environ.get("XAI_API_KEY", "").strip()
    if not api_key:
        return {
            "error_code": "web_provider_credentials_missing",
            "message": "No xAI API key configured for X search. Set XAI_API_KEY.",
        }

    url = "https://api.x.ai/v1/responses"
    tool_spec = {"type": "x_search"}
    if allowed_handles:
        tool_spec["allowed_x_handles"] = [h.lstrip("@") for h in allowed_handles]
    if excluded_handles:
        tool_spec["excluded_x_handles"] = [h.lstrip("@") for h in excluded_handles]
    if from_d:
        tool_spec["from_date"] = from_d
    if to_d:
        tool_spec["to_date"] = to_d

    payload = json.dumps({
        "model": "grok-4.5",
        "input": [{"role": "user", "content": query}],
        "tools": [tool_spec],
    }).encode("utf-8")

    req = urllib.request.Request(
        url, data=payload,
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            citations = []
            for item in data.get("citations") or []:
                link = str(item.get("url") or "")
                citations.append({
                    "url": link,
                    "title": str(item.get("title") or "")[:200],
                    "text": str(item.get("text") or "")[:300],
                })
            return {"provider": "x_search", "query": query, "citations": citations}
    except Exception as exc:
        return {"error_code": "web_fetch_failed", "message": f"xAI request failed: {exc}"}
