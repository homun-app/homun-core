"""Home Assistant integration adapter for Homun.

Provides secure device introspection and control via the Home Assistant REST API.
Enforces domain-level security blocklists to prevent SSRF and arbitrary code execution.
"""

from __future__ import annotations

import re
from typing import Any, Dict, List, Optional
import httpx


_ENTITY_ID_RE = re.compile(r"^[a-z_][a-z0-9_]*\.[a-z0-9_]+$")
_SERVICE_NAME_RE = re.compile(r"^[a-z][a-z0-9_]*$")

# Domains that could execute commands or perform unrestricted network requests on the HA host
BLOCKED_DOMAINS = frozenset({
    "shell_command",
    "command_line",
    "python_script",
    "pyscript",
    "hassio",
    "rest_command",
})


class HomeAssistantError(Exception):
    """Base error for Home Assistant operations."""
    pass


class HomeAssistantSecurityError(HomeAssistantError):
    """Raised when an operation violates security policy or blocked domains."""
    pass


class HomeAssistantNotFoundError(HomeAssistantError):
    """Raised when a requested entity or service does not exist."""
    pass


class HomeAssistantTransportError(HomeAssistantError):
    """Raised when communication with Home Assistant fails."""
    pass


class HomeAssistantAdapter:
    """Controls and inspects Home Assistant instances with security boundaries."""

    def __init__(
        self,
        base_url: str = "http://homeassistant.local:8123",
        token: str = "",
        client: Optional[httpx.Client] = None,
    ) -> None:
        self.base_url = (base_url or "http://homeassistant.local:8123").rstrip("/")
        self.token = token.strip() if token else ""
        self._client = client

    def _get_headers(self) -> Dict[str, str]:
        if not self.token:
            raise HomeAssistantTransportError("Home Assistant token is not configured (HASS_TOKEN missing)")
        return {
            "Authorization": f"Bearer {self.token}",
            "Content-Type": "application/json",
        }

    def _request(self, method: str, path: str, payload: Optional[Any] = None) -> Any:
        headers = self._get_headers()
        url = f"{self.base_url}{path}"
        try:
            if self._client:
                resp = self._client.request(method, url, headers=headers, json=payload, timeout=15.0)
            else:
                with httpx.Client(timeout=15.0) as client:
                    resp = client.request(method, url, headers=headers, json=payload)
        except httpx.RequestError as exc:
            raise HomeAssistantTransportError(f"Network error communicating with Home Assistant: {exc}") from exc

        if resp.status_code == 404:
            raise HomeAssistantNotFoundError(f"Home Assistant resource not found at {path}")
        if resp.status_code in (401, 403):
            raise HomeAssistantSecurityError(f"Home Assistant authentication error ({resp.status_code}): {resp.text}")
        if resp.is_error:
            raise HomeAssistantTransportError(f"Home Assistant returned HTTP {resp.status_code}: {resp.text}")

        return resp.json() if resp.text else {}

    def list_entities(
        self,
        domain: Optional[str] = None,
        area: Optional[str] = None,
    ) -> Dict[str, Any]:
        """List states from Home Assistant filtered by domain and/or area."""
        raw_states = self._request("GET", "/api/states")
        if not isinstance(raw_states, list):
            return {"count": 0, "entities": []}

        filtered = raw_states
        if domain:
            domain_prefix = f"{domain}."
            filtered = [s for s in filtered if str(s.get("entity_id", "")).startswith(domain_prefix)]
        if area:
            area_lower = area.lower()
            filtered = [
                s for s in filtered
                if area_lower in str(s.get("attributes", {}).get("friendly_name", "")).lower()
                or area_lower in str(s.get("attributes", {}).get("area", "")).lower()
            ]

        entities = [
            {
                "entity_id": s.get("entity_id"),
                "state": s.get("state"),
                "friendly_name": s.get("attributes", {}).get("friendly_name", ""),
                "attributes": s.get("attributes", {}),
            }
            for s in filtered
            if "entity_id" in s
        ]
        return {"count": len(entities), "entities": entities}

    def get_state(self, entity_id: str) -> Dict[str, Any]:
        """Get the current state and attributes for an entity."""
        if not _ENTITY_ID_RE.match(entity_id):
            raise HomeAssistantSecurityError(f"Invalid entity_id format: '{entity_id}'")

        data = self._request("GET", f"/api/states/{entity_id}")
        return {
            "entity_id": data.get("entity_id", entity_id),
            "state": data.get("state"),
            "attributes": data.get("attributes", {}),
            "last_changed": data.get("last_changed"),
            "last_updated": data.get("last_updated"),
        }

    def list_services(self) -> List[Dict[str, Any]]:
        """List available services organized by domain."""
        raw = self._request("GET", "/api/services")
        if isinstance(raw, list):
            return raw
        return []

    def call_service(
        self,
        domain: str,
        service: str,
        entity_id: Optional[str] = None,
        service_data: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """Execute a service call against Home Assistant."""
        domain_clean = (domain or "").strip().lower()
        service_clean = (service or "").strip().lower()

        if domain_clean in BLOCKED_DOMAINS:
            raise HomeAssistantSecurityError(f"Access to domain '{domain_clean}' is blocked for security reasons.")
        if not _SERVICE_NAME_RE.match(domain_clean):
            raise HomeAssistantSecurityError(f"Invalid domain format: '{domain_clean}'")
        if not _SERVICE_NAME_RE.match(service_clean):
            raise HomeAssistantSecurityError(f"Invalid service format: '{service_clean}'")

        payload: Dict[str, Any] = dict(service_data or {})
        if entity_id:
            entity_id_clean = entity_id.strip()
            if not _ENTITY_ID_RE.match(entity_id_clean):
                raise HomeAssistantSecurityError(f"Invalid entity_id format: '{entity_id_clean}'")
            payload["entity_id"] = entity_id_clean

        # Track previous state if entity_id is specified to support audit and reversion
        previous_state = None
        if entity_id:
            try:
                previous_state = self.get_state(entity_id)
            except Exception:
                pass

        result = self._request("POST", f"/api/services/{domain_clean}/{service_clean}", payload)
        return {
            "success": True,
            "domain": domain_clean,
            "service": service_clean,
            "entity_id": entity_id,
            "previous_state": previous_state.get("state") if previous_state else None,
            "result": result,
        }
