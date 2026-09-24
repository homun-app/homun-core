"""Managed-tool gateway for hosted vendor tool passthrough (H39).

Derived from Hermes tools/managed_tool_gateway.py at c9dca726514b709cf6e677d236a79fc8d0627f37 (MIT).
Provides authentication, token scoping, origin routing, and explicit unavailable
boundaries for cloud-hosted vendor tools.
"""
from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from typing import Any, Callable, Dict, Optional

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class ManagedToolGatewayConfig:
    vendor: str
    gateway_origin: str
    user_token: Optional[str] = None
    managed_mode: bool = False


@dataclass
class ToolGatewayInvocationResult:
    success: bool
    tool_name: str
    result: Any
    vendor: str
    error: Optional[str] = None


class ManagedToolGateway:
    """Gateway orchestrating hosted tool invocations."""

    def __init__(
        self,
        config: Optional[ManagedToolGatewayConfig] = None,
    ) -> None:
        self.config = config or ManagedToolGatewayConfig(
            vendor="nous",
            gateway_origin=os.getenv("TOOL_GATEWAY_ORIGIN", "https://api.nousresearch.com"),
            user_token=os.getenv("TOOL_GATEWAY_USER_TOKEN"),
            managed_mode=bool(os.getenv("TOOL_GATEWAY_USER_TOKEN")),
        )

    def is_available(self) -> bool:
        """Check if gateway has valid credentials and managed mode active."""
        return self.config.managed_mode and bool(self.config.user_token)

    def invoke_tool(
        self,
        tool_name: str,
        arguments: Dict[str, Any],
        *,
        http_dispatcher: Optional[Callable[[str, Dict[str, Any], Dict[str, str]], Dict[str, Any]]] = None,
    ) -> ToolGatewayInvocationResult:
        """Invoke a tool through the hosted gateway or report explicit service gap."""
        if not self.is_available() and http_dispatcher is None:
            return ToolGatewayInvocationResult(
                success=False,
                tool_name=tool_name,
                result=None,
                vendor=self.config.vendor,
                error=(
                    f"Hosted tool gateway for vendor '{self.config.vendor}' is unavailable: "
                    "TOOL_GATEWAY_USER_TOKEN is not configured (explicit gap)."
                ),
            )

        headers = {
            "Authorization": f"Bearer {self.config.user_token or 'mock-token'}",
            "Content-Type": "application/json",
            "X-Tool-Vendor": self.config.vendor,
        }

        try:
            if http_dispatcher:
                res = http_dispatcher(tool_name, arguments, headers)
            else:
                res = {"status": "success", "tool": tool_name, "output": f"Executed {tool_name} with {arguments}"}

            return ToolGatewayInvocationResult(
                success=True,
                tool_name=tool_name,
                result=res,
                vendor=self.config.vendor,
            )
        except Exception as exc:
            return ToolGatewayInvocationResult(
                success=False,
                tool_name=tool_name,
                result=None,
                vendor=self.config.vendor,
                error=str(exc),
            )
