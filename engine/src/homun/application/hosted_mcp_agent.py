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

    def __init__(self, workspace_id: str = "ws_local", runner: Optional[Any] = None):
        self.workspace_id = workspace_id
        self._runner = runner
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
            runner = getattr(self, "_runner", None) or (ctx.get("runner") if isinstance(ctx, dict) else None)

            if name == "homun_ask":
                question = str(arguments.get("question") or "").strip()
                if not question:
                    return {
                        "isError": True,
                        "content": [{"type": "text", "text": "question is required"}],
                    }
                if runner is None or not callable(getattr(runner, "ask", None)):
                    return {
                        "isError": True,
                        "content": [{
                            "type": "text",
                            "text": (
                                "Homun ask backend is not configured. Wire a runner with "
                                "ask() that executes a real side question; refusing to invent an answer."
                            ),
                        }],
                        "code": "backend_unavailable",
                    }
                ask_kwargs = {"context": str(arguments.get("context") or "")}
                if ctx is not None:
                    ask_kwargs["ctx"] = ctx
                answer = runner.ask(question, **ask_kwargs)
                return {
                    "isError": False,
                    "content": [{"type": "text", "text": str(answer)}],
                }

            if name == "homun_task":
                objective = str(arguments.get("objective") or "").strip()
                if not objective:
                    return {
                        "isError": True,
                        "content": [{"type": "text", "text": "objective is required"}],
                    }
                if runner is None or not callable(getattr(runner, "run_task", None)):
                    return {
                        "isError": True,
                        "content": [{
                            "type": "text",
                            "text": (
                                "Homun task backend is not configured. Wire a runner with "
                                "run_task() that starts a real agent run; refusing to report completion."
                            ),
                        }],
                        "code": "backend_unavailable",
                    }
                task_kwargs = {
                    "files": arguments.get("files") or [],
                    "allow_tools": arguments.get("allow_tools"),
                }
                if ctx is not None:
                    task_kwargs["ctx"] = ctx
                result = runner.run_task(objective, **task_kwargs)
                return {
                    "isError": False,
                    "content": [{"type": "text", "text": json.dumps(result, indent=2, default=str)}],
                }

            if name == "homun_status":
                work_id = str(arguments.get("work_id") or "").strip()
                if not work_id:
                    return {
                        "isError": True,
                        "content": [{"type": "text", "text": "work_id is required"}],
                    }
                if runner is None or not callable(getattr(runner, "get_status", None)):
                    return {
                        "isError": True,
                        "content": [{
                            "type": "text",
                            "text": (
                                "Homun status backend is not configured. Wire a runner with "
                                "get_status() that reads canonical work state."
                            ),
                        }],
                        "code": "backend_unavailable",
                    }
                status_kwargs = {}
                if ctx is not None:
                    status_kwargs["ctx"] = ctx
                status_info = runner.get_status(work_id, **status_kwargs)
                return {
                    "isError": False,
                    "content": [{"type": "text", "text": json.dumps(status_info, indent=2, default=str)}],
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
