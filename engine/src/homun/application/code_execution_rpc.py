"""Host-side RPC server for programmatic code execution tool calls (H13).

Listens on a secure local Unix Domain Socket (or loopback TCP), authenticating
requests with a cryptographic token, enforcing tool whitelists and invocation budgets,
and dispatching calls back into Homun's tool registry.
"""
from __future__ import annotations

import json
import logging
import os
import secrets
import socket
import sys
import threading
import time
from typing import Any, Callable, Dict, List, Optional, Set, Tuple

logger = logging.getLogger(__name__)


class CodeExecutionRpcServer:
    """Threaded local RPC server mediating tool calls from sandbox scripts."""

    def __init__(
        self,
        rpc_token: str,
        allowed_tools: Set[str],
        dispatcher: Callable[[str, Dict[str, Any]], Any],
        max_tool_calls: int = 50,
        socket_dir: Optional[str] = None,
    ):
        self.rpc_token = rpc_token
        self.allowed_tools = set(allowed_tools)
        self.dispatcher = dispatcher
        self.max_tool_calls = max_tool_calls
        self.socket_dir = socket_dir

        self.tool_call_count = 0
        self.tool_call_log: List[Dict[str, Any]] = []
        self._lock = threading.Lock()
        self._shutdown_event = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._clients = {}

        self.is_unix_socket = (sys.platform != "win32")
        self.socket_path: Optional[str] = None
        self.server_port: Optional[int] = None
        self._server_sock: Optional[socket.socket] = None

    def start(self) -> None:
        """Initialize socket and start listening thread."""
        if self.is_unix_socket:
            sock_dir = self.socket_dir or os.environ.get("TMPDIR") or "/tmp"
            self.socket_path = os.path.join(sock_dir, f"homun_rpc_{secrets.token_hex(8)}.sock")
            if os.path.exists(self.socket_path):
                os.remove(self.socket_path)
            self._server_sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            self._server_sock.bind(self.socket_path)
            try:
                os.chmod(self.socket_path, 0o600)
            except Exception:
                pass
        else:
            self._server_sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            self._server_sock.bind(("127.0.0.1", 0))
            self.server_port = self._server_sock.getsockname()[1]

        self._server_sock.listen(8)
        self._server_sock.settimeout(0.5)

        self._thread = threading.Thread(target=self._serve, daemon=True, name="HomunRpcServer")
        self._thread.start()

    def get_connection_info(self) -> Dict[str, Any]:
        """Return socket connection info for child client injection."""
        return {
            "type": "unix" if self.is_unix_socket else "tcp",
            "path": self.socket_path,
            "port": self.server_port,
            "token": self.rpc_token,
        }

    def _serve(self) -> None:
        while not self._shutdown_event.is_set():
            try:
                client_sock, _ = self._server_sock.accept()
            except socket.timeout:
                continue
            except Exception:
                break

            client_thread = threading.Thread(
                target=self._handle_client, args=(client_sock,), daemon=True
            )
            client_thread.start()

    def _handle_client(self, client_sock: socket.socket) -> None:
        client_sock.settimeout(60.0)
        try:
            with client_sock:
                fileobj = client_sock.makefile("rwb")
                while not self._shutdown_event.is_set():
                    line = fileobj.readline(1_048_577)
                    if len(line) > 1_048_576:
                        break
                    if not line:
                        break

                    try:
                        req = json.loads(line.decode("utf-8"))
                        if not isinstance(req, dict):
                            raise ValueError("RPC payload must be an object")
                    except Exception as exc:
                        resp = {"status": "error", "error": f"Invalid JSON payload: {exc}"}
                        fileobj.write(json.dumps(resp).encode("utf-8") + b"\n")
                        fileobj.flush()
                        continue

                    # 1. Token validation
                    req_token = str(req.get("token") or "")
                    if not secrets.compare_digest(req_token.encode(), self.rpc_token.encode()):
                        resp = {"status": "error", "error": "Unauthorized RPC token"}
                        fileobj.write(json.dumps(resp).encode("utf-8") + b"\n")
                        fileobj.flush()
                        continue

                    # 2. Ping / Health
                    if req.get("action") == "ping":
                        resp = {"status": "ok", "pong": True}
                        fileobj.write(json.dumps(resp).encode("utf-8") + b"\n")
                        fileobj.flush()
                        continue

                    tool_name = str(req.get("tool") or "").strip()
                    tool_args = req.get("args") or {}

                    # 3. Allowlist validation
                    if tool_name not in self.allowed_tools or tool_name == "execute_code":
                        resp = {
                            "status": "error",
                            "error": f"Tool '{tool_name}' is not allowed in execute_code sandbox. Available: {sorted(self.allowed_tools)}",
                        }
                        fileobj.write(json.dumps(resp).encode("utf-8") + b"\n")
                        fileobj.flush()
                        continue

                    # 4. Budget check
                    with self._lock:
                        if self.tool_call_count >= self.max_tool_calls:
                            resp = {
                                "status": "error",
                                "error": f"Tool call limit ({self.max_tool_calls}) reached for this execution.",
                            }
                            fileobj.write(json.dumps(resp).encode("utf-8") + b"\n")
                            fileobj.flush()
                            continue
                        self.tool_call_count += 1
                        current_count = self.tool_call_count

                    if self._shutdown_event.is_set():
                        break
                    # 5. Dispatch
                    t0 = time.monotonic()
                    try:
                        result = self.dispatcher(tool_name, tool_args)
                        duration = round(time.monotonic() - t0, 3)
                        with self._lock:
                            self.tool_call_log.append({
                                "tool": tool_name,
                                "count": current_count,
                                "duration_seconds": duration,
                                "success": True,
                            })
                        resp = {"status": "ok", "result": result}
                    except Exception as exc:
                        duration = round(time.monotonic() - t0, 3)
                        with self._lock:
                            self.tool_call_log.append({
                                "tool": tool_name,
                                "count": current_count,
                                "duration_seconds": duration,
                                "success": False,
                                "error": str(exc),
                            })
                        resp = {"status": "error", "error": str(exc)}

                    fileobj.write(json.dumps(resp).encode("utf-8") + b"\n")
                    fileobj.flush()
        except Exception as exc:
            logger.debug("RPC client connection error: %s", exc)
        finally:
            with self._lock:
                self._clients.pop(client_sock, None)

    def stop(self) -> None:
        """Shut down server and remove socket."""
        self._shutdown_event.set()
        if self._server_sock:
            try:
                self._server_sock.close()
            except Exception:
                pass
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=1.0)
        with self._lock:
            clients = list(self._clients.items())
        for client, thread in clients:
            try:
                client.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            client.close()
        deadline = time.monotonic() + 1
        for client, thread in clients:
            thread.join(timeout=max(0, deadline - time.monotonic()))
        if self.socket_path and os.path.exists(self.socket_path):
            try:
                os.remove(self.socket_path)
            except Exception:
                pass
