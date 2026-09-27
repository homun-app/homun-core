"""Configured HTTP dispatch bridge (H39), not full NeMo Relay SDK parity.

Provides corporate relay session isolation, operation mapping, header injection
(x-dynamo-session-id), and explicit unavailable service state when unconfigured.
"""
from __future__ import annotations

import logging
import os
import httpx
from urllib.parse import urlsplit
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, Optional
from uuid import uuid4

logger = logging.getLogger(__name__)


@dataclass
class RelayTurnContext:
    """Context for a managed turn running behind the Relay proxy."""

    session_id: str
    parent_session_id: Optional[str] = None
    metadata: Dict[str, Any] = field(default_factory=dict)


@dataclass
class RelayExecutionResult:
    """Result of an operation executed through Relay."""

    success: bool
    operation: str
    output: Dict[str, Any]
    headers_injected: Dict[str, str]
    error: Optional[str] = None
    error_code: Optional[str] = None
    source: str = "engine"


class RelayRuntime:
    """Homun-owned Relay proxy runtime adapter."""

    def __init__(
        self,
        endpoint_url: Optional[str] = None,
        enabled: Optional[bool] = None,
        *, timeout_seconds: float = 30.0,
    ) -> None:
        self.endpoint_url = endpoint_url or os.getenv("HOMUN_RELAY_ENDPOINT_URL")
        self.enabled = enabled if enabled is not None else os.getenv("HOMUN_RELAY_ENABLED", "").lower() in {"1", "true"}
        self.timeout_seconds = timeout_seconds
        self._active_sessions: Dict[str, RelayTurnContext] = {}

    def is_available(self) -> bool:
        """Check configuration only; this does not probe remote reachability."""
        return self.enabled and bool(self.endpoint_url)

    def create_session(
        self, session_id: Optional[str] = None, parent_session_id: Optional[str] = None
    ) -> RelayTurnContext:
        """Create or bind a relay session context."""
        sid = session_id or f"relay_sess_{uuid4().hex[:8]}"
        ctx = RelayTurnContext(
            session_id=sid,
            parent_session_id=parent_session_id,
            metadata={"homun.provider": "relay"},
        )
        self._active_sessions[sid] = ctx
        return ctx

    def build_headers(self, ctx: RelayTurnContext) -> Dict[str, str]:
        """Generate mandatory proxy routing headers."""
        headers = {"x-dynamo-session-id": ctx.session_id}
        if ctx.parent_session_id:
            headers["x-dynamo-parent-session-id"] = ctx.parent_session_id
        return headers

    def execute_operation(
        self,
        operation: str,
        payload: Dict[str, Any],
        session_id: Optional[str] = None,
        *,
        passthrough_handler: Optional[Callable[[Dict[str, Any], Dict[str, str]], Dict[str, Any]]] = None,
    ) -> RelayExecutionResult:
        """Execute a managed operation through the relay or return explicit unavailable state."""
        ctx = self._active_sessions.get(session_id or "") or self.create_session(session_id)
        headers = self.build_headers(ctx)

        if not self.is_available() and passthrough_handler is None:
            return RelayExecutionResult(
                success=False,
                operation=operation,
                output={},
                headers_injected=headers,
                error="Relay service is not configured or disabled (explicit gap).",
                error_code="backend_unavailable",
            )

        try:
            if passthrough_handler:
                res = passthrough_handler(payload, headers)
            else:
                endpoint = urlsplit(self.endpoint_url)
                if endpoint.scheme not in {"http", "https"} or not endpoint.netloc or endpoint.username or endpoint.password or endpoint.fragment:
                    raise ValueError("Invalid configured HTTP dispatch endpoint")
                # This envelope is Homun's configured bridge contract, not an
                # invented NeMo endpoint. Never retry a possibly accepted effect.
                with httpx.Client(timeout=self.timeout_seconds, follow_redirects=False, trust_env=False) as client:
                    response = client.post(self.endpoint_url, headers=headers,
                                           json={"operation": operation, "payload": payload})
                    response.raise_for_status()
                    res = response.json()
                if not isinstance(res, dict) or not res:
                    raise ValueError("Dispatch response must be a nonempty JSON object")

            return RelayExecutionResult(
                success=True,
                operation=operation,
                output=res,
                headers_injected=headers,
                source="simulation" if passthrough_handler is not None else "engine",
            )
        except Exception as exc:
            return RelayExecutionResult(
                success=False,
                operation=operation,
                output={},
                headers_injected=headers,
                error="HTTP dispatch failed; outcome may be unknown" if isinstance(exc, httpx.RequestError) else "Invalid or rejected dispatch response",
                error_code=("runtime_timeout" if isinstance(exc, httpx.TimeoutException) else
                            "runtime_http_error" if isinstance(exc, httpx.HTTPStatusError) else
                            "runtime_transport_error" if isinstance(exc, httpx.RequestError) else "runtime_protocol_error"),
                source="simulation" if passthrough_handler is not None else "engine",
            )
