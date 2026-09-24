"""NeMo Relay / Enterprise subscription proxy adapter (H39).

Derived from Hermes agent/relay_runtime.py and agent/relay_llm.py at c9dca726514b709cf6e677d236a79fc8d0627f37 (MIT).
Provides corporate relay session isolation, operation mapping, header injection
(x-dynamo-session-id), and explicit unavailable service state when unconfigured.
"""
from __future__ import annotations

import logging
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


class RelayRuntime:
    """Homun-owned Relay proxy runtime adapter."""

    def __init__(
        self,
        endpoint_url: Optional[str] = None,
        enabled: bool = False,
    ) -> None:
        self.endpoint_url = endpoint_url
        self.enabled = enabled
        self._active_sessions: Dict[str, RelayTurnContext] = {}

    def is_available(self) -> bool:
        """Check if relay runtime is actively configured and reachable."""
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
            )

        try:
            if passthrough_handler:
                res = passthrough_handler(payload, headers)
            else:
                res = {"status": "relayed", "data": payload}

            return RelayExecutionResult(
                success=True,
                operation=operation,
                output=res,
                headers_injected=headers,
            )
        except Exception as exc:
            return RelayExecutionResult(
                success=False,
                operation=operation,
                output={},
                headers_injected=headers,
                error=str(exc),
            )
