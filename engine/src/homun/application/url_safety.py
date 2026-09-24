"""URL safety validation and SSRF prevention (H40).

Derived from Hermes tools/url_safety.py at c9dca726514b709cf6e677d236a79fc8d0627f37 (MIT).
Prevents Server-Side Request Forgery (SSRF) to private networks, loopback interfaces,
and cloud metadata endpoints (169.254.169.254, metadata.google.internal). Detects
credentials embedded in URLs (userinfo) and credential-bearing query parameters.
"""
from __future__ import annotations

import ipaddress
import logging
import re
import socket
from typing import Optional, Set, Tuple
from urllib.parse import parse_qsl, quote, unquote, urlsplit, urlunsplit

logger = logging.getLogger(__name__)

_HTTP_SCHEMES = frozenset({"http", "https"})

# Cloud metadata hostnames - always blocked
_BLOCKED_HOSTNAMES = frozenset({
    "metadata.google.internal",
    "metadata.goog",
    "instance-data",
})

# Cloud metadata IP addresses - always blocked
_BLOCKED_METADATA_IPS = frozenset({
    ipaddress.ip_address("169.254.169.254"),  # AWS, Azure, GCP, OpenStack
    ipaddress.ip_address("100.100.100.200"),  # Alibaba Cloud
})

# Unambiguously credential-bearing query parameter names
_SENSITIVE_QUERY_PARAM_NAMES: Set[str] = frozenset({
    "access_token",
    "api_key",
    "apikey",
    "auth_token",
    "authorization",
    "awsaccesskeyid",
    "client_secret",
    "credential",
    "credentials",
    "jwt",
    "password",
    "passwd",
    "secret",
    "session_id",
    "signature",
    "token",
    "x_amz_security_token",
    "x_amz_signature",
    "x-amz-security-token",
    "x-amz-signature",
})


def normalize_url_for_request(url: str) -> str:
    """Normalize URL, performing IDNA encoding on hostname and safe URI quoting."""
    if not isinstance(url, str):
        return url
    raw = url.strip()
    if not raw:
        return raw

    # Fix model-emitted whitespace between scheme separator and authority
    raw = re.sub(r"^([A-Za-z][A-Za-z0-9+.-]*://)\s+", r"\1", raw)
    try:
        parsed = urlsplit(raw)
    except ValueError:
        return raw

    if parsed.scheme.lower() not in _HTTP_SCHEMES:
        return raw

    netloc = parsed.netloc
    hostname = parsed.hostname
    if hostname:
        try:
            ascii_host = hostname.encode("idna").decode("ascii")
        except UnicodeError:
            ascii_host = hostname
        if ascii_host != hostname:
            netloc = netloc.replace(hostname, ascii_host, 1)

    safe = "/%:@!$&'()*+,;="
    return urlunsplit((
        parsed.scheme,
        netloc,
        quote(parsed.path, safe=safe),
        quote(parsed.query, safe=safe + "?"),
        quote(parsed.fragment, safe=safe + "?"),
    ))


def sensitive_query_param_name(url: str) -> Optional[str]:
    """Return the name of any sensitive/credential query parameter found in URL."""
    if not isinstance(url, str) or "?" not in url:
        return None
    try:
        parsed = urlsplit(url.strip())
    except ValueError:
        return None
    if parsed.scheme.lower() not in _HTTP_SCHEMES or not parsed.query:
        return None

    for key, value in parse_qsl(parsed.query, keep_blank_values=True):
        if value and unquote(key).lower() in _SENSITIVE_QUERY_PARAM_NAMES:
            return key
    return None


def is_ip_blocked(ip: ipaddress.IPv4Address | ipaddress.IPv6Address, allow_private: bool = False) -> Tuple[bool, Optional[str]]:
    """Check if an IP address is blocked under SSRF safety rules."""
    # Check cloud metadata endpoints first
    if ip in _BLOCKED_METADATA_IPS:
        return True, f"Access to cloud metadata endpoint ({ip}) is blocked."

    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped:
        mapped_v4 = ip.ipv4_mapped
        if mapped_v4 in _BLOCKED_METADATA_IPS:
            return True, f"Access to cloud metadata endpoint ({mapped_v4}) is blocked."

    if allow_private:
        return False, None

    if ip.is_loopback:
        return True, f"Access to loopback address ({ip}) is blocked."

    if ip.is_private:
        return True, f"Access to private network address ({ip}) is blocked."

    if ip.is_link_local:
        return True, f"Access to link-local address ({ip}) is blocked."

    if ip.is_reserved:
        return True, f"Access to reserved address ({ip}) is blocked."

    return False, None


def is_safe_url(
    url: str,
    *,
    allow_private: bool = False,
    resolve_dns: bool = True,
) -> Tuple[bool, Optional[str]]:
    """Validate whether an outbound HTTP/HTTPS URL is safe from SSRF and credential leaks.

    Returns (is_safe, error_reason).
    """
    if not isinstance(url, str) or not url.strip():
        return False, "URL cannot be empty."

    norm_url = normalize_url_for_request(url)
    try:
        parsed = urlsplit(norm_url)
    except ValueError as exc:
        return False, f"Malformed URL: {exc}"

    scheme = parsed.scheme.lower()
    if scheme not in _HTTP_SCHEMES:
        return False, f"Unsupported URL scheme '{scheme}': only http and https are allowed."

    if not parsed.hostname:
        return False, "URL is missing a valid hostname."

    # Check for credentials in userinfo (e.g. http://user:pass@host/)
    if parsed.username or parsed.password:
        return False, "URL contains embedded credentials in userinfo."

    # Check for sensitive query parameters (e.g. ?api_key=...)
    sensitive_param = sensitive_query_param_name(norm_url)
    if sensitive_param:
        return False, f"URL contains sensitive credential query parameter '{sensitive_param}'."

    hostname = parsed.hostname.lower()
    if hostname in _BLOCKED_HOSTNAMES:
        return False, f"Access to blocked hostname '{hostname}' is denied."

    # Check if hostname is a direct IP literal
    try:
        ip = ipaddress.ip_address(hostname)
        blocked, reason = is_ip_blocked(ip, allow_private=allow_private)
        if blocked:
            return False, reason
        return True, None
    except ValueError:
        pass

    # Resolve hostname to IPs if requested
    if resolve_dns:
        try:
            # Look up IPv4 and IPv6 addresses
            addr_info = socket.getaddrinfo(hostname, None)
            for item in addr_info:
                sockaddr = item[4]
                ip_str = sockaddr[0]
                ip = ipaddress.ip_address(ip_str)
                blocked, reason = is_ip_blocked(ip, allow_private=allow_private)
                if blocked:
                    return False, f"Hostname '{hostname}' resolves to blocked IP: {reason}"
        except socket.gaierror as exc:
            # If DNS resolution fails, reject to fail-closed
            return False, f"DNS resolution failed for hostname '{hostname}': {exc}"

    return True, None
