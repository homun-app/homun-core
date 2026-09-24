"""One headless browser Homun starts and stops.

The profile directory belongs to the engine. The person's Chrome profile is
never selected. Only the process group started here is signaled.
"""
from __future__ import annotations

import base64
import json
import os
import signal
import socket
import subprocess
import time
from pathlib import Path
from urllib.parse import urlsplit

from .layout import confine_directory
from .web_pages import PageRefusal, _classify

TEXT_LIMIT = 12_000
_DIALOG_TYPES = frozenset({"alert", "confirm", "prompt", "beforeunload"})
_DIALOG_LIMIT = 8
_CANDIDATES = (
    Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
    Path("/usr/bin/google-chrome"),
    Path("/usr/bin/chromium"),
    Path("/usr/bin/chromium-browser"),
)


def chrome_path() -> Path | None:
    for path in _CANDIDATES:
        if path.is_file():
            return path
    return None


def _read_exact(sock: socket.socket, count: int) -> bytes:
    buf = b""
    while len(buf) < count:
        chunk = sock.recv(count - len(buf))
        if not chunk:
            raise OSError("browser connection closed")
        buf += chunk
    return buf


def _send_text(sock: socket.socket, text: str) -> None:
    data = text.encode()
    mask = os.urandom(4)
    header = bytearray([0x81])
    length = len(data)
    if length < 126:
        header.append(0x80 | length)
    elif length < 65536:
        header.append(0x80 | 126)
        header.extend(length.to_bytes(2, "big"))
    else:
        header.append(0x80 | 127)
        header.extend(length.to_bytes(8, "big"))
    header.extend(mask)
    sock.sendall(bytes(header) + bytes(byte ^ mask[index % 4] for index, byte in enumerate(data)))


def _recv_text(sock: socket.socket) -> str:
    while True:
        first, second = _read_exact(sock, 2)
        opcode = first & 0x0F
        length = second & 0x7F
        if length == 126:
            length = int.from_bytes(_read_exact(sock, 2), "big")
        elif length == 127:
            length = int.from_bytes(_read_exact(sock, 8), "big")
        if second & 0x80:
            mask = _read_exact(sock, 4)
            payload = bytes(byte ^ mask[index % 4] for index, byte in enumerate(_read_exact(sock, length)))
        else:
            payload = _read_exact(sock, length)
        if opcode == 0x1:
            return payload.decode()
        if opcode == 0x8:
            raise OSError("browser connection closed")
        if opcode == 0x9:
            sock.sendall(bytes([0x8A, 0x80]) + os.urandom(4))


class _TooManyDialogs(Exception):
    """A page opened more native dialogs than one read will close."""


class _Page:
    def __init__(self, sock: socket.socket):
        self.sock = sock
        self.seq = 0
        self.events: list[dict] = []
        self.replies: dict[int, dict] = {}

    def call(self, method: str, params: dict | None = None, timeout: float = 15, notice=None) -> dict:
        self.seq += 1
        current = self.seq
        _send_text(self.sock, json.dumps({"id": current, "method": method, "params": params or {}}))
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if current in self.replies:
                return self.replies.pop(current)
            self.sock.settimeout(max(0.1, deadline - time.monotonic()))
            message = json.loads(_recv_text(self.sock))
            incoming = message.get("id")
            if incoming == current:
                return message
            if incoming is not None:
                self.replies[incoming] = message
                continue
            if "method" in message:
                self.events.append(message)
                if notice is not None:
                    notice()
        raise TimeoutError(method)


def _websocket(url: str) -> socket.socket:
    parsed = urlsplit(url)
    if parsed.hostname != "127.0.0.1" or parsed.scheme != "ws":
        raise PageRefusal("web_address_refused", "The browser endpoint is not local")
    sock = socket.create_connection(("127.0.0.1", parsed.port), timeout=10)
    key = base64.b64encode(os.urandom(16)).decode()
    request = (
        f"GET {parsed.path} HTTP/1.1\r\nHost: 127.0.0.1:{parsed.port}\r\n"
        "Upgrade: websocket\r\nConnection: Upgrade\r\n"
        f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n"
    )
    sock.sendall(request.encode())
    header = b""
    while b"\r\n\r\n" not in header:
        chunk = sock.recv(4096)
        if not chunk:
            break
        header += chunk
    if b" 101 " not in header.split(b"\r\n", 1)[0]:
        sock.close()
        raise OSError("browser websocket was refused")
    return sock


class OwnedBrowser:
    def __init__(self, root: Path):
        binary = chrome_path()
        if binary is None:
            raise PageRefusal("browser_unavailable", "No owned browser is installed")
        self.root = confine_directory(Path(root).absolute())
        profile = confine_directory(self.root / "profile")
        self.argv = [
            str(binary), "--headless=new", "--disable-gpu", "--no-first-run",
            "--no-default-browser-check", "--disable-extensions", "--disable-sync",
            f"--user-data-dir={profile}", "--remote-debugging-port=0",
            "--remote-allow-origins=*", "about:blank",
        ]
        self.process = subprocess.Popen(
            self.argv, cwd=self.root, stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        self._page: _Page | None = None
        self.refs: dict[str, dict] = {}
        self.receipts: dict[str, dict] = {}

    def _port(self) -> int:
        marker = self.root / "profile" / "DevToolsActivePort"
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            if marker.is_file():
                return int(marker.read_text().splitlines()[0])
            if self.process.poll() is not None:
                raise OSError("browser exited before it was ready")
            time.sleep(0.05)
        raise TimeoutError("browser did not publish a local port")

    def _page_socket(self) -> _Page:
        if self._page is not None:
            return self._page
        port = self._port()
        probe = socket.create_connection(("127.0.0.1", port), timeout=5)
        probe.settimeout(5)
        probe.sendall(
            f"GET /json/list HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n".encode())
        raw = b""
        while b"\r\n\r\n" not in raw:
            raw += probe.recv(4096)
        head, body = raw.split(b"\r\n\r\n", 1)
        length = 0
        for line in head.decode().split("\r\n"):
            if line.lower().startswith("content-length:"):
                length = int(line.split(":", 1)[1].strip())
        while len(body) < length:
            body += probe.recv(4096)
        probe.close()
        body = body[:length]
        pages = [item for item in json.loads(body) if item.get("type") == "page" and item.get("webSocketDebuggerUrl")]
        if not pages:
            raise OSError("browser has no page")
        self._page = _Page(_websocket(pages[0]["webSocketDebuggerUrl"]))
        self._page.call("Page.enable")
        self._page.call("Runtime.enable")
        return self._page

    def _dismiss_dialogs(self) -> list[dict]:
        """Close native dialogs without accepting them. A read must not confirm."""
        page = self._page
        if page is None:
            return []
        found: list[dict] = []
        while True:
            index = next((i for i, event in enumerate(page.events)
                          if event.get("method") == "Page.javascriptDialogOpening"), None)
            if index is None:
                return found
            params = page.events.pop(index).get("params") or {}
            kind = str(params.get("type") or "")
            if kind not in _DIALOG_TYPES:
                continue
            if len(found) >= _DIALOG_LIMIT:
                raise _TooManyDialogs()
            page.call("Page.handleJavaScriptDialog", {"accept": False})
            found.append({
                "type": kind,
                "message": str(params.get("message") or "")[:500],
                "action": "dismiss",
            })

    def wait_document(self, *, dismiss_dialogs: bool) -> dict:
        """Wait until the current public page has loaded. A read does not accept dialogs."""
        page = self._page
        if page is None:
            return {"error_code": "web_fetch_failed", "message": "The browser has no page"}
        dialogs: list[dict] = []

        def notice() -> None:
            dialogs.extend(self._dismiss_dialogs())

        watcher = notice if dismiss_dialogs else None
        try:
            deadline = time.monotonic() + 15
            href = ""
            while time.monotonic() < deadline:
                if watcher is not None:
                    watcher()
                location = page.call(
                    "Runtime.evaluate", {"expression": "location.href", "returnByValue": True}, notice=watcher)
                href = str(((location.get("result") or {}).get("result") or {}).get("value") or "")
                state = page.call(
                    "Runtime.evaluate", {"expression": "document.readyState", "returnByValue": True}, notice=watcher)
                ready = str(((state.get("result") or {}).get("result") or {}).get("value") or "")
                if href.startswith(("http://", "https://")) and ready == "complete":
                    break
                time.sleep(0.1)
            else:
                return {"error_code": "web_fetch_failed", "message": "The browser did not finish loading"}
            if watcher is not None:
                watcher()
        except _TooManyDialogs:
            return {"error_code": "web_fetch_failed", "message": "The page opened too many dialogs"}
        try:
            _classify(href)
        except PageRefusal as exc:
            return {"error_code": exc.code, "message": exc.message}
        settled = {"url": href}
        if dialogs:
            settled["dialogs"] = dialogs
        return settled

    def read(self, url: str, *, dismiss_dialogs: bool = False) -> dict:
        _classify(url)
        page = self._page_socket()
        self.refs = {}
        early: list[dict] = []

        def notice() -> None:
            early.extend(self._dismiss_dialogs())

        try:
            page.call("Page.navigate", {"url": url}, notice=notice if dismiss_dialogs else None)
        except _TooManyDialogs:
            return {"error_code": "web_fetch_failed", "message": "The page opened too many dialogs"}
        settled = self.wait_document(dismiss_dialogs=dismiss_dialogs)
        if "error_code" in settled:
            return settled
        if early:
            settled["dialogs"] = early + list(settled.get("dialogs") or [])
        evaluated = page.call(
            "Runtime.evaluate",
            {"expression": "document.body ? document.body.innerText : ''", "returnByValue": True})
        text = str(((evaluated.get("result") or {}).get("result") or {}).get("value") or "")
        result = {"url": settled["url"], "text": text[:TEXT_LIMIT], "truncated": len(text) > TEXT_LIMIT}
        if settled.get("dialogs"):
            result["dialogs"] = settled["dialogs"]
        return result

    def close(self) -> None:
        if self._page is not None:
            self._page.sock.close()
            self._page = None
        if self.process.poll() is None:
            os.killpg(self.process.pid, signal.SIGTERM)
            try:
                self.process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                os.killpg(self.process.pid, signal.SIGKILL)
                self.process.wait(timeout=3)


def read_page(root: Path, url: str, *, dismiss_dialogs: bool = False) -> dict:
    """Open one public page in a private browser and always close that process."""
    try:
        _classify(url)
    except PageRefusal as exc:
        return {"error_code": exc.code, "message": exc.message}
    if chrome_path() is None:
        return {"error_code": "browser_unavailable", "message": "No owned browser is installed"}
    browser = OwnedBrowser(root)
    try:
        if "Application Support/Google/Chrome" in " ".join(browser.argv):
            return {"error_code": "browser_unavailable", "message": "The person's browser profile was refused"}
        return browser.read(url, dismiss_dialogs=dismiss_dialogs)
    except PageRefusal as exc:
        return {"error_code": exc.code, "message": exc.message}
    except (TimeoutError, OSError, json.JSONDecodeError):
        return {"error_code": "web_fetch_failed", "message": "The browser could not read the page"}
    finally:
        browser.close()
