"""Optional Chronos-compatible cron provider adapter (H29).

c9dca726514b709cf6e677d236a79fc8d0627f37 (MIT). Homun does not invent remote
schedule state: without HOMUN_CHRONOS_URL the adapter reports unavailable.
"""
from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)


@dataclass
class ChronosStatus:
    configured: bool
    ready: bool
    base_url: Optional[str]
    error: Optional[str] = None
    code: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "configured": self.configured,
            "ready": self.ready,
            "base_url": self.base_url,
            "error": self.error,
            "code": self.code,
            "provider": "chronos",
        }


class ChronosProvider:
    """Thin HTTP client for an external Chronos-like scheduler API."""

    def __init__(self, base_url: Optional[str] = None, *, timeout: float = 10.0) -> None:
        self.base_url = (base_url or os.environ.get("HOMUN_CHRONOS_URL") or "").rstrip("/") or None
        self.timeout = timeout

    def status(self) -> ChronosStatus:
        if not self.base_url:
            return ChronosStatus(
                configured=False,
                ready=False,
                base_url=None,
                error="Chronos provider is not configured (set HOMUN_CHRONOS_URL)",
                code="backend_unavailable",
            )
        try:
            import httpx

            with httpx.Client(timeout=self.timeout) as client:
                resp = client.get(f"{self.base_url}/health")
            if resp.status_code >= 400:
                return ChronosStatus(
                    configured=True,
                    ready=False,
                    base_url=self.base_url,
                    error=f"Chronos health returned HTTP {resp.status_code}",
                    code="backend_unavailable",
                )
            return ChronosStatus(configured=True, ready=True, base_url=self.base_url)
        except Exception as exc:
            return ChronosStatus(
                configured=True,
                ready=False,
                base_url=self.base_url,
                error=str(exc),
                code="backend_unavailable",
            )

    def list_remote_jobs(self) -> List[Dict[str, Any]]:
        st = self.status()
        if not st.ready:
            raise RuntimeError(st.error or "Chronos unavailable")
        import httpx

        with httpx.Client(timeout=self.timeout) as client:
            resp = client.get(f"{self.base_url}/v1/jobs")
            resp.raise_for_status()
            data = resp.json()
        if isinstance(data, list):
            return data
        if isinstance(data, dict) and isinstance(data.get("jobs"), list):
            return data["jobs"]
        return []

    def create_remote_job(self, spec: Dict[str, Any]) -> Dict[str, Any]:
        st = self.status()
        if not st.ready:
            raise RuntimeError(st.error or "Chronos unavailable")
        import httpx

        with httpx.Client(timeout=self.timeout) as client:
            resp = client.post(f"{self.base_url}/v1/jobs", json=spec)
            resp.raise_for_status()
            data = resp.json()
        return data if isinstance(data, dict) else {"job": data}

    def delete_remote_job(self, job_id: str) -> bool:
        st = self.status()
        if not st.ready:
            raise RuntimeError(st.error or "Chronos unavailable")
        import httpx

        with httpx.Client(timeout=self.timeout) as client:
            resp = client.delete(f"{self.base_url}/v1/jobs/{job_id}")
            if resp.status_code == 404:
                return False
            resp.raise_for_status()
            return True

    def trigger_remote_job(self, job_id: str) -> Dict[str, Any]:
        st = self.status()
        if not st.ready:
            raise RuntimeError(st.error or "Chronos unavailable")
        import httpx

        with httpx.Client(timeout=self.timeout) as client:
            resp = client.post(f"{self.base_url}/v1/jobs/{job_id}/trigger")
            resp.raise_for_status()
            data = resp.json()
        return data if isinstance(data, dict) else {"result": data}

