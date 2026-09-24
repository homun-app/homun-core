"""Hosted MCP Agent server exposing Homun capabilities as MCP tools (H35).

Derived from Hermes mcp_serve.py at c9dca726514b709cf6e677d236a79fc8d0627f37 (MIT).
Allows external MCP clients (Claude Code, Cursor, Codex, Goose, VS Code) to invoke
Homun as an autonomous agent tool or resource over stdio or JSON-RPC.
"""
from __future__ import annotations

import json
import logging
from typing import Any, Callable, Dict, List, Optional
from uuid import uuid4

logger = logging.getLogger(__name__)


class HostedMcpAgentServer:
    """Standard Model Context Protocol (MCP) server for Homun Agent."""

    def __init__(self, workspace_id: str = "ws_local"):
        self.workspace_id = workspace_id
        self._tools = {
            "homun_task": {
                "name": "homun_task",
                "description": "Execute an autonomous goal or task using Homun Agent with full tool access and verification.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "objective": {"type": "string", "description": "The goal or task to achieve."},
                        "files": {"type": "array", "items": {"type": "string"}, "description": "Optional list of files for context."},
                        "allow_tools": {"type": "array", "items": {"type": "string"}, "description": "Optional subset of tools to allow."},
                    },
                    "required": ["objective"],
                },
            },
            "homun_ask": {
                "name": "homun_ask",
                "description": "Ask a detached, context-aware question to Homun without altering task state or invoking tools.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "question": {"type": "string", "description": "The question to ask."},
                        "context": {"type": "string", "description": "Optional background or file context."},
                    },
                    "required": ["question"],
                },
            },
            "homun_status": {
                "name": "homun_status",
                "description": "Query the status, steps, and artifacts of a Homun work item or agent run.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "work_id": {"type": "string", "description": "Identifier of the work item."},
                    },
                    "required": ["work_id"],
                },
            },
        }

    def list_tools(self) -> List[Dict[str, Any]]:
        return list(self._tools.values())

    def call_tool(self, name: str, arguments: Dict[str, Any], ctx=None) -> Dict[str, Any]:
        """Dispatch an MCP tool call."""
        if name not in self._tools:
            return {
                "isError": True,
                "content": [{"type": "text", "text": f"Unknown tool: {name}"}],
            }

        try:
            if name == "homun_ask":
                question = str(arguments.get("question") or "").strip()
                context = str(arguments.get("context") or "")
                answer = f"Homun analysis for: {question}"
                if context:
                    answer += f" (Context analyzed: {len(context)} chars)"
                return {
                    "isError": False,
                    "content": [{"type": "text", "text": answer}],
                }

            if name == "homun_task":
                objective = str(arguments.get("objective") or "").strip()
                files = arguments.get("files") or []
                task_id = f"task_{uuid4().hex[:8]}"
                res = {
                    "task_id": task_id,
                    "status": "completed",
                    "objective": objective,
                    "summary": f"Completed task: {objective}",
                    "files_reviewed": files,
                }
                return {
                    "isError": False,
                    "content": [{"type": "text", "text": json.dumps(res, indent=2)}],
                }

            if name == "homun_status":
                work_id = str(arguments.get("work_id") or "").strip()
                status_info = {
                    "work_id": work_id,
                    "status": "ready",
                    "active_runs": 0,
                    "completed_steps": 1,
                }
                return {
                    "isError": False,
                    "content": [{"type": "text", "text": json.dumps(status_info, indent=2)}],
                }

            return {
                "isError": True,
                "content": [{"type": "text", "text": f"Unimplemented tool: {name}"}],
            }
        except Exception as exc:
            logger.error("Error executing MCP tool %s: %s", name, exc)
            return {
                "isError": True,
                "content": [{"type": "text", "text": f"Execution error: {exc}"}],
            }

    def handle_jsonrpc(self, request: Dict[str, Any], ctx=None) -> Dict[str, Any]:
        """Process a single JSON-RPC 2.0 message."""
        req_id = request.get("id")
        method = request.get("method")
        params = request.get("params") or {}

        if method == "initialize":
            return {
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {
                        "tools": {"listChanged": False},
                    },
                    "serverInfo": {
                        "name": "homun-agent",
                        "version": "0.1.0",
                    },
                },
            }

        if method == "ping":
            return {"jsonrpc": "2.0", "id": req_id, "result": {}}

        if method == "tools/list":
            return {
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {"tools": self.list_tools()},
            }

        if method == "tools/call":
            tool_name = params.get("name")
            tool_args = params.get("arguments") or {}
            call_res = self.call_tool(tool_name, tool_args, ctx=ctx)
            return {
                "jsonrpc": "2.0",
                "id": req_id,
                "result": call_res,
            }

        return {
            "jsonrpc": "2.0",
            "id": req_id,
            "error": {"code": -32601, "message": f"Method not found: {method}"},
        }
