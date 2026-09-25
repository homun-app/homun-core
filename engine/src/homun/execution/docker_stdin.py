"""Write bytes to an already running container stdin. Never starts a container.

Delivery rule: raw bytes,
no added newline, and no automatic repeat after an uncertain send.
"""
from __future__ import annotations

import socket
from homun.execution.contracts import ExecutionTimeout, ExecutionUnavailable, ExecutionUncertain


class StdinNotSent(ExecutionUnavailable):
    """The daemon accepted no stdin bytes, so the same call may try again."""


def send(socket_path: str, container_id: str, payload: bytes, *, timeout: float = 5) -> None:
    if timeout <= 0 or not socket_path.startswith("/") or "\n" in socket_path or ".." in socket_path.split("/"):
        raise StdinNotSent("Docker socket path is not usable")
    if len(container_id) != 64 or any(c not in "0123456789abcdef" for c in container_id):
        raise StdinNotSent("Container id is not a Docker identifier")
    if not payload or len(payload) > 8192:
        raise ValueError("Stdin payload is empty or too large")
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.settimeout(timeout)
    sent = False
    try:
        try:
            sock.connect(socket_path)
            sock.sendall(
                f"POST /v1.44/containers/{container_id}/attach?stdin=1&stdout=0&stderr=0&stream=1 HTTP/1.1\r\n"
                "Host: localhost\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n"
                "Content-Type: application/vnd.docker.raw-stream\r\n\r\n".encode())
            header = bytearray()
            while b"\r\n\r\n" not in header:
                chunk = sock.recv(4096)
                if not chunk or len(header) > 8192:
                    raise StdinNotSent("Docker did not accept stdin")
                header.extend(chunk)
            if not header.startswith(b"HTTP/1.1 101"):
                raise StdinNotSent("Docker did not accept stdin")
            sent = True
            sock.sendall(payload)
        except StdinNotSent:
            raise
        except socket.timeout:
            if sent:
                raise ExecutionUncertain("Stdin delivery could not be confirmed") from None
            raise ExecutionTimeout("Docker stdin timed out before delivery") from None
        except OSError:
            if sent:
                raise ExecutionUncertain("Stdin delivery could not be confirmed") from None
            raise StdinNotSent("Docker stdin could not be opened") from None
    finally:
        sock.close()
