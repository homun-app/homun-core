"""Fetch one public web page and return bounded text.

Private, loopback, and link-local addresses are refused before any connection.
The person's proxy environment is ignored, and the socket is opened to an
address that was just classified. This is not a search provider.
"""
from __future__ import annotations

import http.client
import ipaddress
import socket
import ssl
from html.parser import HTMLParser
from urllib.parse import parse_qsl, urlencode, urljoin, urlsplit

MAX_BYTES = 1_000_000
TEXT_LIMIT = 12_000
_BLOCKED_HOSTS = frozenset({"localhost", "metadata.google.internal", "metadata.google.com"})
_BLOCKED_SUFFIXES = (".localhost", ".local", ".internal")
_SENSITIVE_QUERY = frozenset({
    "access_token", "api_key", "apikey", "auth_token", "authorization", "awsaccesskeyid",
    "client_secret", "credential", "credentials", "jwt", "password", "passwd", "secret",
    "session_id", "signature", "token", "x_amz_security_token", "x_amz_signature",
    "x-amz-security-token", "x-amz-signature",
})
_REDIRECTS = {301, 302, 303, 307, 308}
_TEXT_TYPES = ("text/html", "text/plain", "application/xhtml+xml")


class PageRefusal(Exception):
    def __init__(self, code: str, message: str):
        self.code = code
        self.message = message


class _VisibleText(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self._skip = 0
        self.parts: list[str] = []

    def handle_starttag(self, tag, attrs):
        if tag in {"script", "style", "noscript"}:
            self._skip += 1
        if tag in {"p", "div", "br", "li", "h1", "h2", "h3", "tr", "section"}:
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag in {"script", "style", "noscript"} and self._skip:
            self._skip -= 1

    def handle_data(self, data):
        if not self._skip:
            self.parts.append(data)


def visible_text(raw: bytes, content_type: str) -> str:
    """Return readable text. HTML tags, scripts, and styles are omitted."""
    charset = "utf-8"
    for piece in content_type.split(";")[1:]:
        name, _, value = piece.strip().partition("=")
        if name.lower() == "charset" and value:
            charset = value.strip('"')
    try:
        text = raw.decode(charset, errors="replace")
    except LookupError:
        text = raw.decode("utf-8", errors="replace")
    if content_type.split(";", 1)[0].strip().lower() == "text/plain":
        return text
    parser = _VisibleText()
    parser.feed(text)
    lines = [" ".join(line.split()) for line in "".join(parser.parts).splitlines()]
    return "\n".join(line for line in lines if line)


def _blocked(address: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped is not None:
        address = address.ipv4_mapped
    return not address.is_global


def _classify(url: str) -> tuple[str, str, int, str, str]:
    if not isinstance(url, str) or not url.strip() or len(url) > 2000 or "\n" in url or "\r" in url:
        raise PageRefusal("web_url_refused", "The URL is empty or not a single public http(s) address")
    parsed = urlsplit(url.strip())
    scheme = parsed.scheme.lower()
    if scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
        raise PageRefusal("web_url_refused", "Only public http(s) URLs without credentials are accepted")
    host = parsed.hostname.lower()
    if host in _BLOCKED_HOSTS or host.endswith(_BLOCKED_SUFFIXES):
        raise PageRefusal("web_address_refused", "That host is not a public web address")
    for name, _ in parse_qsl(parsed.query, keep_blank_values=True):
        if name.lower() in _SENSITIVE_QUERY:
            raise PageRefusal("web_url_refused", "The URL contains a credential query parameter")
    port = parsed.port or (443 if scheme == "https" else 80)
    path = parsed.path or "/"
    if parsed.query:
        path = f"{path}?{parsed.query}"
    try:
        literal = ipaddress.ip_address(host)
    except ValueError:
        literal = None
    if literal is not None:
        if _blocked(literal):
            raise PageRefusal("web_address_refused", "That address is not public")
        return scheme, host, port, path, host
    try:
        infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except socket.gaierror as exc:
        raise PageRefusal("web_address_unresolved", "The host name did not resolve") from exc
    addresses = []
    for info in infos:
        address = ipaddress.ip_address(info[4][0])
        if _blocked(address):
            raise PageRefusal("web_address_refused", "The host resolves to a non-public address")
        addresses.append(info[4][0])
    if not addresses:
        raise PageRefusal("web_address_unresolved", "The host name did not resolve")
    return scheme, host, port, path, addresses[0]


def _open(scheme: str, host: str, port: int, address: str):
    if _blocked(ipaddress.ip_address(address)):
        raise PageRefusal("web_address_refused", "That address is not public")
    sock = socket.create_connection((address, port), timeout=10)
    sock.settimeout(10)
    if scheme == "http":
        connection = http.client.HTTPConnection(host, port, timeout=10)
        connection.sock = sock
        return connection
    context = ssl.create_default_context()
    connection = http.client.HTTPSConnection(host, port, timeout=10, context=context)
    connection.sock = context.wrap_socket(sock, server_hostname=host)
    return connection


def _exchange(scheme: str, host: str, port: int, path: str, address: str, *, method: str = "GET", payload: bytes | None = None) -> tuple[int, str, str, bytes, bool]:
    connection = _open(scheme, host, port, address)
    headers = {
        "Host": host if port in {80, 443} else f"{host}:{port}",
        "User-Agent": "Homun",
        "Accept": "text/html,text/plain",
        "Accept-Encoding": "identity",
        "Connection": "close",
    }
    if payload is not None:
        headers["Content-Type"] = "application/x-www-form-urlencoded"
    try:
        connection.request(method, path, body=payload, headers=headers)
        response = connection.getresponse()
        body = response.read(MAX_BYTES + 1)
        kind = response.headers.get("Content-Type", "")
        location = response.headers.get("Location", "")
        return response.status, kind, location, body, len(body) > MAX_BYTES
    finally:
        connection.close()


def fetch_page(url: str) -> dict:
    """Return bounded page text, or a typed refusal. Never raises for a bad page."""
    current = url
    try:
        for _ in range(4):
            scheme, host, port, path, address = _classify(current)
            status, kind, location, body, oversized = _exchange(scheme, host, port, path, address)
            if status in _REDIRECTS:
                if not location:
                    return {"error_code": "web_fetch_failed", "message": "The page redirected without a destination"}
                current = urljoin(current, location)
                continue
            if status != 200:
                return {"error_code": "web_fetch_failed", "message": f"The page returned status {status}", "status": status}
            media = kind.split(";", 1)[0].strip().lower()
            if media not in _TEXT_TYPES:
                return {"error_code": "web_content_unsupported", "message": "The page is not HTML or plain text", "status": status}
            text = visible_text(body[:MAX_BYTES], kind)
            truncated = oversized or len(text) > TEXT_LIMIT
            if len(text) > TEXT_LIMIT:
                text = text[:TEXT_LIMIT]
            return {"url": current, "status": status, "content_type": media, "text": text, "truncated": truncated}
    except PageRefusal as exc:
        return {"error_code": exc.code, "message": exc.message}
    except (TimeoutError, OSError, http.client.HTTPException, ssl.SSLError):
        return {"error_code": "web_fetch_failed", "message": "The page could not be read"}
    return {"error_code": "web_fetch_failed", "message": "The page redirected too many times"}


class _SearchResults(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.results: list[dict[str, str]] = []
        self._mode = ""
        self._href = ""
        self._buf: list[str] = []

    def handle_starttag(self, tag, attrs):
        if tag != "a":
            return
        classes = set(dict(attrs).get("class", "").split())
        href = dict(attrs).get("href", "")
        if "result__a" in classes:
            self._mode = "title"
            self._href = href
            self._buf = []
        elif "result__snippet" in classes:
            self._mode = "snippet"
            self._buf = []

    def handle_data(self, data):
        if self._mode:
            self._buf.append(data)

    def handle_endtag(self, tag):
        if tag != "a" or not self._mode:
            return
        text = " ".join("".join(self._buf).split())
        if self._mode == "title" and self._href:
            self.results.append({"url": self._href, "title": text[:200], "snippet": ""})
        elif self._mode == "snippet" and self.results:
            self.results[-1]["snippet"] = text[:300]
        self._mode = ""
        self._buf = []


def search_hits(raw: bytes, limit: int = 5) -> list[dict[str, str]]:
    """Keep public http(s) results from a DuckDuckGo HTML page."""
    parser = _SearchResults()
    parser.feed(raw.decode("utf-8", errors="replace"))
    kept = []
    for hit in parser.results:
        try:
            _classify(hit["url"])
        except PageRefusal:
            continue
        kept.append(hit)
        if len(kept) >= limit:
            break
    return kept


def search_public(query: str) -> dict:
    """Return a short public result list. An empty list is not an invented answer."""
    if not isinstance(query, str) or not query.strip() or len(query) > 500 or "\n" in query or "\r" in query:
        return {"error_code": "web_query_refused", "message": "The search query is empty or not a single line"}
    payload = urlencode({"q": query.strip()}).encode()
    try:
        scheme, host, port, path, address = _classify("https://html.duckduckgo.com/html/")
        status, _kind, _location, body, _oversized = _exchange(
            scheme, host, port, path, address, method="POST", payload=payload)
    except PageRefusal as exc:
        return {"error_code": exc.code, "message": exc.message}
    except (TimeoutError, OSError, http.client.HTTPException, ssl.SSLError):
        return {"error_code": "web_fetch_failed", "message": "The search page could not be read"}
    if status != 200:
        return {"error_code": "web_fetch_failed", "message": f"The search page returned status {status}", "status": status}
    results = search_hits(body[:MAX_BYTES])
    if not results and b"result__a" not in body:
        return {"error_code": "web_fetch_failed", "message": "The search page did not return results"}
    return {"provider": "duckduckgo-html", "query": query.strip(), "results": results}
