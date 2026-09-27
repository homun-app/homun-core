"""REST API routes for alternate runtimes, subscription proxy, relay, and tool gateway (H39)."""
from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field, ConfigDict

from homun.application.codex_runtime import CodexAppServerAdapter
from homun.application.copilot_acp_client import CopilotAcpClient
from homun.application.managed_tool_gateway import ManagedToolGateway
from homun.application.relay_runtime import RelayRuntime

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1/runtimes", tags=["alternate_runtimes"])


class CodexTurnRequest(BaseModel):
    messages: List[Dict[str, Any]]
    model_config = ConfigDict(extra="forbid")


class CopilotAcpRequest(BaseModel):
    prompt: str
    model_config = ConfigDict(extra="forbid")


class RelayDispatchRequest(BaseModel):
    operation: str
    payload: Dict[str, Any]
    session_id: Optional[str] = None
    model_config = ConfigDict(extra="forbid")


class ToolGatewayRequest(BaseModel):
    tool_name: str
    arguments: Dict[str, Any]
    vendor: Optional[str] = "nous"


@router.get("/status", response_model=Dict[str, Any])
def get_runtimes_status() -> Dict[str, Any]:
    """Report availability and configuration status of alternate runtimes."""
    copilot = CopilotAcpClient()
    relay = RelayRuntime()
    gateway = ManagedToolGateway()

    return {
        "codex_app_server": {
            "supported": True,
            "protocol": "json-rpc-stdio",
        },
        "copilot_acp": {
            "supported": True,
            "binary_available": copilot.is_available(),
            "command": copilot.command,
        },
        "relay_proxy": {
            "supported": True,
            "enabled": relay.is_available(),
        },
        "managed_tool_gateway": {
            "supported": True,
            "active": gateway.is_available(),
            "configured": gateway.is_configured(),
            "vendor": gateway.config.vendor,
        },
    }


@router.post("/codex/turn", response_model=Dict[str, Any])
def run_codex_turn(req: CodexTurnRequest) -> Dict[str, Any]:
    """Execute a turn through the Codex App-Server protocol adapter."""
    adapter = CodexAppServerAdapter()
    res = adapter.run_turn(req.messages)
    return {
        "status": res.status, "source": res.source, "error_code": res.error_code,
        "error": res.error, "thread_id": res.thread_id, "turn_id": res.turn_id,
        "text": res.text,
        "reasoning": res.reasoning,
        "tool_calls": res.tool_calls,
        "tokens_used": res.tokens_used,
        "duration_seconds": res.duration_seconds,
        "interrupted": res.interrupted,
    }


@router.post("/copilot-acp/turn", response_model=Dict[str, Any])
def run_copilot_acp_turn(req: CopilotAcpRequest) -> Dict[str, Any]:
    """Execute a turn through the Copilot ACP client adapter."""
    client = CopilotAcpClient()
    res = client.run_turn(req.prompt)
    return {
        "text": res.text,
        "tool_calls": res.tool_calls,
        "is_available": res.is_available,
        "error": res.error,
    }


@router.post("/relay/dispatch", response_model=Dict[str, Any])
def dispatch_relay_operation(req: RelayDispatchRequest) -> Dict[str, Any]:
    """Dispatch once through the configured HTTP Relay bridge."""
    relay = RelayRuntime()
    res = relay.execute_operation(req.operation, req.payload, session_id=req.session_id)
    return {
        "success": res.success,
        "operation": res.operation,
        "output": res.output,
        "headers_injected": res.headers_injected,
        "error_code": res.error_code, "source": res.source,
        "error": res.error,
    }


@router.post("/tool-gateway/invoke", response_model=Dict[str, Any])
def invoke_tool_gateway(req: ToolGatewayRequest) -> Dict[str, Any]:
    """Invoke a tool via the managed cloud tool gateway."""
    gateway = ManagedToolGateway()
    res = gateway.invoke_tool(req.tool_name, req.arguments)
    return {
        "success": res.success,
        "tool_name": res.tool_name,
        "result": res.result,
        "vendor": res.vendor,
        "error": res.error,
        "error_code": res.error_code,
    }
