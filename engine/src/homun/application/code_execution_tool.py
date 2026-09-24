"""Programmatic Code Execution Tool with child RPC bridge (H13).

Derived from Hermes tools/code_execution_tool.py at c9dca726514b709cf6e677d236a79fc8d0627f37 (MIT).
Homun runs Python scripts in an isolated child interpreter with a injected
`call_tool(tool_name, args)` bridge communicating back to the host RPC server,
allowing programmatic tool composition, client-side filtering, and output reduction.
"""
from __future__ import annotations

import logging
import os
import secrets
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Set, Tuple

from homun.application.code_execution_contracts import (
    DEFAULT_MAX_TOOL_CALLS,
    DEFAULT_TIMEOUT,
    MAX_STDERR_BYTES,
    MAX_STDOUT_BYTES,
    CodeExecutionResult,
)
from homun.application.code_execution_rpc import CodeExecutionRpcServer
from homun.domain.errors import ValidationError

logger = logging.getLogger(__name__)

CLIENT_BOOTSTRAP_TEMPLATE = """# --- Homun Programmatic Tool Calling Bridge ---
import json
import socket
import sys

_RPC_TYPE = {rpc_type!r}
_RPC_PATH = {rpc_path!r}
_RPC_PORT = {rpc_port!r}
_RPC_TOKEN = {rpc_token!r}

def call_tool(tool_name, args=None):
    if args is None:
        args = {{}}
    if _RPC_TYPE == "unix":
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.connect(_RPC_PATH)
    else:
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.connect(("127.0.0.1", _RPC_PORT))
    with s:
        req = {{"token": _RPC_TOKEN, "tool": tool_name, "args": args}}
        s.sendall(json.dumps(req).encode("utf-8") + b"\\n")
        f = s.makefile("r", encoding="utf-8")
        resp_line = f.readline()
        if not resp_line:
            raise RuntimeError("RPC server closed connection unexpectedly")
        res = json.loads(resp_line)
        if res.get("status") == "error":
            raise RuntimeError(res.get("error") or "Tool call failed")
        return res.get("result")

# --- End Homun Bridge ---
"""


def truncate_output(text: str, max_bytes: int = MAX_STDOUT_BYTES) -> Tuple[str, bool]:
    """Truncate output if it exceeds max_bytes, keeping 40% head and 60% tail."""
    encoded = text.encode("utf-8", errors="replace")
    if len(encoded) <= max_bytes:
        return text, False

    head_bytes = int(max_bytes * 0.4)
    tail_bytes = int(max_bytes * 0.6)

    head = encoded[:head_bytes].decode("utf-8", errors="replace")
    tail = encoded[-tail_bytes:].decode("utf-8", errors="replace")
    omitted = len(encoded) - (head_bytes + tail_bytes)

    marker = f"\n\n[... Homun: omitted {omitted} bytes of output ...]\n\n"
    return head + marker + tail, True


def run_code_with_rpc(
    code: str,
    allowed_tools: Set[str],
    dispatcher: Callable[[str, Dict[str, Any]], Any],
    *,
    cwd: Optional[Path] = None,
    timeout: int = DEFAULT_TIMEOUT,
    max_tool_calls: int = DEFAULT_MAX_TOOL_CALLS,
) -> CodeExecutionResult:
    """Execute Python code in a child process with local tool RPC bridge."""
    rpc_token = secrets.token_hex(16)
    server = CodeExecutionRpcServer(
        rpc_token=rpc_token,
        allowed_tools=allowed_tools,
        dispatcher=dispatcher,
        max_tool_calls=max_tool_calls,
    )
    server.start()
    conn_info = server.get_connection_info()

    bootstrap = CLIENT_BOOTSTRAP_TEMPLATE.format(
        rpc_type=conn_info["type"],
        rpc_path=conn_info["path"],
        rpc_port=conn_info["port"],
        rpc_token=conn_info["token"],
    )
    full_script = bootstrap + "\n" + code

    t0 = time.monotonic()
    script_file: Optional[str] = None
    try:
        with tempfile.NamedTemporaryFile("w", suffix=".py", delete=False, encoding="utf-8") as tf:
            tf.write(full_script)
            script_file = tf.name

        work_dir = str(cwd) if cwd else os.getcwd()
        proc = subprocess.Popen(
            [sys.executable, script_file],
            cwd=work_dir,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )

        try:
            stdout_raw, stderr_raw = proc.communicate(timeout=timeout)
            exit_code = proc.returncode
            err_msg = None
        except subprocess.TimeoutExpired:
            proc.kill()
            stdout_raw, stderr_raw = proc.communicate()
            exit_code = -1
            err_msg = f"Execution timed out after {timeout} seconds"

        duration = round(time.monotonic() - t0, 3)
        stdout_clean, truncated = truncate_output(stdout_raw, MAX_STDOUT_BYTES)
        stderr_clean, _ = truncate_output(stderr_raw, MAX_STDERR_BYTES)

        return CodeExecutionResult(
            exit_code=exit_code,
            stdout=stdout_clean,
            stderr=stderr_clean,
            tool_calls_count=server.tool_call_count,
            tool_call_log=list(server.tool_call_log),
            truncated=truncated,
            duration_seconds=duration,
            error=err_msg,
        )
    finally:
        server.stop()
        if script_file and os.path.exists(script_file):
            try:
                os.remove(script_file)
            except Exception:
                pass


def execute(ctx, actor, run, tool: str, args: Dict[str, Any]) -> Dict[str, Any]:
    """Execute execute_code tool proposal for an active agent run."""
    policy = run.get("code_execution", {}).get("policy")
    if policy != "programmatic-v1":
        raise ValidationError("Code execution tools are not enabled for this run")

    code = str(args.get("code") or "").strip()
    if not code:
        raise ValidationError("Code parameter is required for 'execute_code'")

    timeout = int(args.get("timeout") or DEFAULT_TIMEOUT)
    max_tool_calls = int(args.get("max_tool_calls") or DEFAULT_MAX_TOOL_CALLS)

    # Resolve allowed tools from current run manifest
    import importlib
    registry_module = importlib.import_module("homun.application.agent_tool_registry")
    run_copy = dict(run)
    run_copy.setdefault("assignee_id", "default")
    reg = registry_module.registry_for(run_copy)
    allowed_tools = {t["name"] for t in reg.manifest() if t.get("name") != "execute_code"}

    def dispatch(tool_name: str, tool_args: Dict[str, Any]) -> Any:
        return reg.dispatch(tool_name, tool_args, ctx=ctx, actor=actor, run=run)

    cwd_path = Path(run.get("cwd") or os.getcwd())
    result = run_code_with_rpc(
        code=code,
        allowed_tools=allowed_tools,
        dispatcher=dispatch,
        cwd=cwd_path,
        timeout=timeout,
        max_tool_calls=max_tool_calls,
    )
    return result.to_dict()
