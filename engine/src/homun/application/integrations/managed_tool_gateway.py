"""Managed-tool gateway for hosted vendor tool passthrough (H39).

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
    error_code: Optional[str] = None


class ManagedToolGateway:
    """Gateway orchestrating hosted tool invocations."""

    def __init__(
        self,
        config: Optional[ManagedToolGatewayConfig] = None,
        *, http_dispatcher: Optional[Callable] = None,
    ) -> None:
        self.http_dispatcher = http_dispatcher
        self.config = config or ManagedToolGatewayConfig(
            vendor="nous",
            gateway_origin=os.getenv("TOOL_GATEWAY_ORIGIN", "https://api.nousresearch.com"),
            user_token=os.getenv("TOOL_GATEWAY_USER_TOKEN"),
            managed_mode=bool(os.getenv("TOOL_GATEWAY_USER_TOKEN")),
        )

    def is_configured(self) -> bool:
        return self.config.managed_mode and bool(self.config.user_token)

    def is_available(self) -> bool:
        """Credentials alone do not provide an executable transport."""
        return self.is_configured() and self.http_dispatcher is not None

    def invoke_tool(
        self,
        tool_name: str,
        arguments: Dict[str, Any],
        *,
        http_dispatcher: Optional[Callable[[str, Dict[str, Any], Dict[str, str]], Dict[str, Any]]] = None,
    ) -> ToolGatewayInvocationResult:
        """Invoke a tool through the hosted gateway or report explicit service gap."""
        if not self.is_configured():
            return ToolGatewayInvocationResult(
                success=False,
                tool_name=tool_name,
                result=None,
                vendor=self.config.vendor,
                error_code="tool_gateway_unconfigured",
                error=(
                    f"Hosted tool gateway for vendor '{self.config.vendor}' is unavailable: "
                    "TOOL_GATEWAY_USER_TOKEN is not configured (explicit gap)."
                ),
            )

        dispatcher = http_dispatcher if http_dispatcher is not None else self.http_dispatcher
        if dispatcher is None:
            return ToolGatewayInvocationResult(False, tool_name, None, self.config.vendor,
                error="Hosted tool gateway has no executable transport configured.",
                error_code="tool_gateway_unavailable")

        headers = {
            "Authorization": f"Bearer {self.config.user_token}",
            "Content-Type": "application/json",
            "X-Tool-Vendor": self.config.vendor,
        }

        try:
            res = dispatcher(tool_name, arguments, headers)

            return ToolGatewayInvocationResult(
                success=True,
                tool_name=tool_name,
                result=res,
                vendor=self.config.vendor,
            )
        except Exception:
            return ToolGatewayInvocationResult(
                success=False,
                tool_name=tool_name,
                result=None,
                vendor=self.config.vendor,
                error="Hosted tool dispatch failed; execution outcome is unknown. Do not retry automatically.",
                error_code="tool_gateway_outcome_unknown",
            )
