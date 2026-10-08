"""Spotify integration adapter for Homun.

Provides Spotify Web API controls for playback, search, track inspection,
and user library management with reversible track saving/removal.
"""

from __future__ import annotations

import re
from typing import Any, Dict, List, Optional
import httpx

SPOTIFY_API_BASE = "https://api.spotify.com/v1"
_URI_PATTERN = re.compile(r"^spotify:(track|album|artist|playlist):([a-zA-Z0-9]{22})$")
_ID_PATTERN = re.compile(r"^[a-zA-Z0-9]{22}$")


class SpotifyError(Exception):
    """Base error for Spotify operations."""
    pass


class SpotifyAuthRequiredError(SpotifyError):
    """Raised when Spotify authentication is missing or token is expired."""
    pass


class SpotifyAPIError(SpotifyError):
    """Raised when Spotify Web API returns an error response."""
    def __init__(self, status: int, message: str):
        super().__init__(f"Spotify API error {status}: {message}")
        self.status = status
        self.message = message


def normalize_spotify_uri(uri_or_id: str, expected_type: str = "track") -> str:
    """Ensure a Spotify identifier is in standard 'spotify:type:id' format."""
    val = (uri_or_id or "").strip()
    match = _URI_PATTERN.match(val)
    if match:
        item_type, item_id = match.groups()
        if expected_type and item_type != expected_type:
            raise SpotifyError(f"Expected Spotify URI type '{expected_type}', got '{item_type}'")
        return val

    if _ID_PATTERN.match(val):
        return f"spotify:{expected_type}:{val}"

    raise SpotifyError(f"Invalid Spotify URI or ID format: '{val}'")


def normalize_spotify_id(uri_or_id: str) -> str:
    """Extract raw 22-character Spotify ID from a URI or plain ID."""
    val = (uri_or_id or "").strip()
    match = _URI_PATTERN.match(val)
    if match:
        return match.group(2)
    if _ID_PATTERN.match(val):
        return val
    raise SpotifyError(f"Invalid Spotify identifier format: '{val}'")


class SpotifyAdapter:
    """Controls Spotify playback and manages tracks via Web API."""

    def __init__(
        self,
        access_token: str = "",
        client: Optional[httpx.Client] = None,
    ) -> None:
        self.token = access_token.strip() if access_token else ""
        self._client = client

    def _get_headers(self) -> Dict[str, str]:
        if not self.token:
            raise SpotifyAuthRequiredError("Spotify access token is missing or not configured")
        return {
            "Authorization": f"Bearer {self.token}",
            "Content-Type": "application/json",
        }

    def _request(
        self,
        method: str,
        path: str,
        params: Optional[Dict[str, Any]] = None,
        body: Optional[Dict[str, Any]] = None,
    ) -> Any:
        headers = self._get_headers()
        url = f"{SPOTIFY_API_BASE}{path}"
        try:
            if self._client:
                resp = self._client.request(
                    method,
                    url,
                    headers=headers,
                    params=params,
                    json=body,
                    timeout=15.0,
                )
            else:
                with httpx.Client(timeout=15.0) as client:
                    resp = client.request(
                        method,
                        url,
                        headers=headers,
                        params=params,
                        json=body,
                    )
        except httpx.RequestError as exc:
            raise SpotifyError(f"Network transport error calling Spotify: {exc}") from exc

        if resp.status_code == 204:
            return None

        if resp.status_code == 401:
            raise SpotifyAuthRequiredError(f"Spotify authentication failed: {resp.text}")

        if resp.is_error:
            raise SpotifyAPIError(resp.status_code, resp.text)

        return resp.json() if resp.text else {}

    def get_playback_state(self) -> Dict[str, Any]:
        """Get current playback state and currently playing track."""
        res = self._request("GET", "/me/player")
        return res or {"is_playing": False, "item": None}

    def play(
        self,
        context_uri: Optional[str] = None,
        uris: Optional[List[str]] = None,
        device_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Start or resume playback."""
        params = {"device_id": device_id} if device_id else None
        body: Dict[str, Any] = {}
        if context_uri:
            body["context_uri"] = context_uri
        if uris:
            body["uris"] = [normalize_spotify_uri(u, expected_type="track") for u in uris]
        self._request("PUT", "/me/player/play", params=params, body=body if body else None)
        return {"success": True, "action": "play"}

    def pause(self, device_id: Optional[str] = None) -> Dict[str, Any]:
        """Pause playback."""
        params = {"device_id": device_id} if device_id else None
        self._request("PUT", "/me/player/pause", params=params)
        return {"success": True, "action": "pause"}

    def next_track(self, device_id: Optional[str] = None) -> Dict[str, Any]:
        """Skip to next track."""
        params = {"device_id": device_id} if device_id else None
        self._request("POST", "/me/player/next", params=params)
        return {"success": True, "action": "next"}

    def previous_track(self, device_id: Optional[str] = None) -> Dict[str, Any]:
        """Skip to previous track."""
        params = {"device_id": device_id} if device_id else None
        self._request("POST", "/me/player/previous", params=params)
        return {"success": True, "action": "previous"}

    def seek(self, position_ms: int, device_id: Optional[str] = None) -> Dict[str, Any]:
        """Seek to position in currently playing track."""
        params: Dict[str, Any] = {"position_ms": max(0, position_ms)}
        if device_id:
            params["device_id"] = device_id
        self._request("PUT", "/me/player/seek", params=params)
        return {"success": True, "action": "seek", "position_ms": position_ms}

    def set_volume(self, volume_percent: int, device_id: Optional[str] = None) -> Dict[str, Any]:
        """Set playback volume (0..100)."""
        clamped = max(0, min(100, volume_percent))
        params: Dict[str, Any] = {"volume_percent": clamped}
        if device_id:
            params["device_id"] = device_id
        self._request("PUT", "/me/player/volume", params=params)
        return {"success": True, "action": "volume", "volume_percent": clamped}

    def search(
        self,
        query: str,
        types: Optional[List[str]] = None,
        limit: int = 20,
        offset: int = 0,
    ) -> Dict[str, Any]:
        """Search Spotify catalog for items."""
        search_types = ",".join(types) if types else "track,artist,album"
        params = {
            "q": query,
            "type": search_types,
            "limit": max(1, min(50, limit)),
            "offset": max(0, offset),
        }
        return self._request("GET", "/search", params=params)

    def get_track(self, track_id: str) -> Dict[str, Any]:
        """Get track details by ID or URI."""
        tid = normalize_spotify_id(track_id)
        return self._request("GET", f"/tracks/{tid}")

    def save_track(self, track_id: str) -> Dict[str, Any]:
        """Save a track to the user's library (reversible via remove_track)."""
        tid = normalize_spotify_id(track_id)
        self._request("PUT", "/me/tracks", params={"ids": tid})
        return {"success": True, "action": "save_track", "track_id": tid}

    def remove_track(self, track_id: str) -> Dict[str, Any]:
        """Remove a track from the user's library (reverses save_track)."""
        tid = normalize_spotify_id(track_id)
        self._request("DELETE", "/me/tracks", params={"ids": tid})
        return {"success": True, "action": "remove_track", "track_id": tid}
