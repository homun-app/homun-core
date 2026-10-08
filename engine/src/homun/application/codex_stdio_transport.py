"""Bounded, one-shot Codex app-server JSON-RPC transport.

Wire protocol follows the pinned Hermes transport reference. This deliberately
requires terminal evidence; partial output and process death never imply success.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import queue
import shutil
import signal
import subprocess
import threading
import time
from collections import deque
from typing import Any, Callable


class CodexTransportError(RuntimeError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


class CodexStdioTransport:
    def __init__(self, command: str, args: list[str] | None = None, *,
                 cwd: str | None = None, timeout_seconds: float = 60):
        self.command = command
        self.args = list(args if args is not None else ["app-server"])
        self.cwd = str(Path(cwd or os.getcwd()).resolve())
        self.timeout_seconds = timeout_seconds

    def run(self, prompt: str, *, on_event: Callable[[dict], None],
            interrupt_event: threading.Event) -> dict[str, Any]:
        if not shutil.which(self.command):
            raise CodexTransportError("backend_unavailable", "Codex executable is not available")
        if self.timeout_seconds <= 0:
            raise CodexTransportError("runtime_timeout", "Codex deadline must be positive")
        try:
            proc = subprocess.Popen([self.command, *self.args], cwd=self.cwd,
                                    stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                    stderr=subprocess.PIPE, text=True, encoding="utf-8",
                                    errors="replace", bufsize=1, start_new_session=os.name == "posix")
        except OSError as exc:
            raise CodexTransportError("backend_unavailable", "Could not start Codex process") from exc
        inbox: queue.Queue = queue.Queue()
        stderr_tail: deque = deque(maxlen=20)

        def pump_stdout():
            try:
                for line in proc.stdout:
                    try:
                        msg = json.loads(line)
                        if not isinstance(msg, dict):
                            raise ValueError("JSON-RPC object required")
                        inbox.put(msg)
                    except (ValueError, TypeError):
                        inbox.put(CodexTransportError("runtime_protocol_error", "Invalid Codex JSON-RPC message"))
            finally:
                inbox.put(None)

        def pump_stderr():
            for line in proc.stderr:
                stderr_tail.append(line[-2048:])

        pumps = [threading.Thread(target=pump_stdout, daemon=True),
                 threading.Thread(target=pump_stderr, daemon=True)]
        for thread in pumps:
            thread.start()
        deadline = time.monotonic() + self.timeout_seconds
        request_id = 0
        pending: list[dict] = []
        thread_id = turn_id = None
        interrupted_sent = False
        stopped = threading.Event()

        def watchdog():
            cancel_at = None
            while not stopped.wait(.02):
                if interrupt_event.is_set() and cancel_at is None:
                    cancel_at = time.monotonic() + (2 if thread_id and turn_id else .1)
                if time.monotonic() >= deadline or (cancel_at is not None and time.monotonic() >= cancel_at):
                    try:
                        if os.name == 'posix':
                            os.killpg(proc.pid, signal.SIGKILL)
                        else:
                            proc.kill()
                    except OSError:
                        pass
                    return

        guardian = threading.Thread(target=watchdog, daemon=True)
        guardian.start()

        def transport_failure(message):
            code = ('runtime_interrupted' if interrupt_event.is_set() else
                    'runtime_timeout' if time.monotonic() >= deadline else 'runtime_protocol_error')
            return CodexTransportError(code, message)

        def send(message):
            try:
                proc.stdin.write(json.dumps({"jsonrpc": "2.0", **message}) + "\n")
                proc.stdin.flush()
            except (OSError, ValueError) as exc:
                raise transport_failure("Codex stdin closed") from exc

        def next_message():
            nonlocal interrupted_sent, deadline, request_id
            while time.monotonic() < deadline:
                if interrupt_event.is_set() and not (thread_id and turn_id):
                    raise CodexTransportError("runtime_interrupted", "Codex initialization interrupted")
                if interrupt_event.is_set() and not interrupted_sent and thread_id and turn_id:
                    request_id += 1
                    send({"id": request_id, "method": "turn/interrupt",
                          "params": {"threadId": thread_id, "turnId": turn_id}})
                    interrupted_sent = True
                    deadline = min(deadline, time.monotonic() + 2)
                try:
                    msg = inbox.get(timeout=min(0.05, max(0.001, deadline - time.monotonic())))
                except queue.Empty:
                    continue
                if msg is None:
                    raise transport_failure("Codex exited without terminal turn evidence")
                if isinstance(msg, Exception):
                    raise msg
                return msg
            raise CodexTransportError("runtime_timeout", "Codex turn timed out; execution outcome may be incomplete")

        def server_request(msg):
            if "id" not in msg or "method" not in msg:
                return False
            method = msg["method"]
            if method in {"item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/permissions/requestApproval"}:
                send({"id": msg["id"], "result": {"decision": "decline"}})
            elif method == "mcpServer/elicitation/request":
                send({"id": msg["id"], "result": {"action": "decline", "content": None}})
            else:
                send({"id": msg["id"], "error": {"code": -32601, "message": "Unsupported server request"}})
            return True

        def object_value(value):
            if not isinstance(value, dict):
                raise CodexTransportError("runtime_protocol_error", "Expected Codex protocol object")
            return value

        def request(method, params):
            nonlocal request_id
            request_id += 1
            wanted = request_id
            send({"id": wanted, "method": method, "params": params})
            while True:
                msg = next_message()
                if server_request(msg):
                    continue
                if msg.get("id") == wanted:
                    if "error" in msg:
                        raise CodexTransportError("runtime_failed", f"Codex {method} rejected")
                    if not isinstance(msg.get("result"), dict):
                        raise CodexTransportError("runtime_protocol_error", f"Invalid {method} result")
                    return msg["result"]
                if "method" in msg:
                    pending.append(msg)

        try:
            request("initialize", {"clientInfo": {"name": "homun-engine", "title": "Homun", "version": "0.1.0"}, "capabilities": {}})
            send({"method": "initialized"})
            result = request("thread/start", {"cwd": self.cwd, "sandbox": "read-only", "approvalPolicy": "untrusted"})
            thread_id = object_value(result.get("thread")).get("id")
            if not isinstance(thread_id, str) or not thread_id:
                raise CodexTransportError("runtime_protocol_error", "Missing Codex thread ID")
            if interrupt_event.is_set():
                return {"thread_id": thread_id, "turn_id": None, "status": "interrupted"}
            result = request("turn/start", {"threadId": thread_id, "input": [{"type": "text", "text": prompt}]})
            turn_id = object_value(result.get("turn")).get("id")
            if not isinstance(turn_id, str) or not turn_id:
                raise CodexTransportError("runtime_protocol_error", "Missing Codex turn ID")
            while True:
                if time.monotonic() >= deadline:
                    raise CodexTransportError("runtime_timeout", "Codex turn deadline exceeded")
                msg = pending.pop(0) if pending else next_message()
                if server_request(msg) or "method" not in msg:
                    continue
                params = msg.get("params")
                if not isinstance(params, dict):
                    raise CodexTransportError("runtime_protocol_error", "Invalid notification parameters")
                if params.get("threadId") != thread_id:
                    continue
                for key in ("turn", "item", "tokenUsage"):
                    if key in params:
                        object_value(params[key])
                observed_turn = params.get("turnId") or (params.get("turn") or {}).get("id")
                if msg["method"] != "thread/tokenUsage/updated" and observed_turn != turn_id:
                    continue
                if "delta" in params and not isinstance(params["delta"], str):
                    raise CodexTransportError("runtime_protocol_error", "Invalid Codex text delta")
                if "tokenUsage" in params and "last" in params["tokenUsage"]:
                    object_value(params["tokenUsage"]["last"])
                on_event(msg)
                if msg["method"] == "turn/completed":
                    turn = params.get("turn") or {}
                    status = turn.get("status")
                    if status not in {"completed", "interrupted"} or turn.get("error"):
                        raise CodexTransportError("runtime_failed", "Codex turn failed")
                    return {"thread_id": thread_id, "turn_id": turn_id, "status": status}
        finally:
            stopped.set()
            guardian.join(timeout=1)
            # Kill the isolated process group too: app-server can own tool children.
            if os.name == "posix":
                try:
                    os.killpg(proc.pid, signal.SIGTERM)
                except OSError:
                    pass
            elif proc.poll() is None:
                proc.terminate()
            if proc.poll() is None:
                proc.terminate()
            try:
                proc.wait(timeout=1)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=1)
            if os.name == "posix":
                try:
                    os.killpg(proc.pid, signal.SIGKILL)
                except OSError:
                    pass
            for thread in pumps:
                thread.join(timeout=1)
            for pipe in (proc.stdin, proc.stdout, proc.stderr):
                try:
                    pipe.close()
                except OSError:
                    pass
