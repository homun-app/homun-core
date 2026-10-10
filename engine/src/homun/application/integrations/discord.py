"""Discord integration adapter for Homun.

Provides server introspection, channel interaction, role and message management via Discord REST API v10.
Supports intent awareness, response payload bounding, and reversible actions.
"""

from __future__ import annotations

import json
from typing import Any, Dict, List, Optional
import httpx

DISCORD_API_BASE = "https://discord.com/api/v10"
MAX_RESPONSE_BYTES = 4 * 1024 * 1024
MAX_ERROR_BYTES = 64 * 1024

FLAGS_GUILD_MEMBERS = (1 << 14) | (1 << 15)
FLAGS_MESSAGE_CONTENT = (1 << 18) | (1 << 19)


class DiscordAPIError(Exception):
    """Base exception for Discord API failures."""
    def __init__(self, status: int, message: str, body: Optional[str] = None):
        super().__init__(f"Discord API error {status}: {message}")
        self.status = status
        self.body = body or ""


class DiscordPermissionError(DiscordAPIError):
    """Raised when Discord returns 401 or 403 Forbidden."""
    pass


class DiscordNotFoundError(DiscordAPIError):
    """Raised when Discord returns 404 Not Found."""
    pass


class DiscordAdapter:
    """Discord REST API client with bounded responses and typed actions."""

    def __init__(self, bot_token: str = "", client: Optional[httpx.Client] = None) -> None:
        self.token = bot_token.strip() if bot_token else ""
        self._client = client

    def _get_headers(self) -> Dict[str, str]:
        if not self.token:
            raise DiscordPermissionError(401, "Discord bot token is missing or not configured")
        return {
            "Authorization": f"Bot {self.token}",
            "Content-Type": "application/json",
            "User-Agent": "Homun-Agent (https://github.com/homun-app/homun-core)",
        }

    def _request(
        self,
        method: str,
        path: str,
        params: Optional[Dict[str, Any]] = None,
        body: Optional[Dict[str, Any]] = None,
    ) -> Any:
        headers = self._get_headers()
        url = f"{DISCORD_API_BASE}{path}"
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
            raise DiscordAPIError(502, f"Network transport error: {exc}") from exc

        if resp.status_code == 204:
            return None

        content_bytes = resp.content
        if len(content_bytes) > MAX_RESPONSE_BYTES:
            raise DiscordAPIError(502, f"Discord response exceeded limit of {MAX_RESPONSE_BYTES} bytes")

        if resp.status_code in (401, 403):
            err_text = content_bytes[:MAX_ERROR_BYTES].decode("utf-8", errors="replace")
            raise DiscordPermissionError(resp.status_code, "Permission denied or missing intent", err_text)

        if resp.status_code == 404:
            err_text = content_bytes[:MAX_ERROR_BYTES].decode("utf-8", errors="replace")
            raise DiscordNotFoundError(404, "Discord resource not found", err_text)

        if resp.is_error:
            err_text = content_bytes[:MAX_ERROR_BYTES].decode("utf-8", errors="replace")
            raise DiscordAPIError(resp.status_code, f"HTTP {resp.status_code}", err_text)

        return resp.json() if resp.text else {}

    def list_guilds(self) -> List[Dict[str, Any]]:
        """List guilds/servers the bot is currently in."""
        res = self._request("GET", "/users/@me/guilds")
        return res if isinstance(res, list) else []

    def get_server_info(self, guild_id: str) -> Dict[str, Any]:
        """Fetch guild details including approximate member and presence counts."""
        return self._request("GET", f"/guilds/{guild_id}", params={"with_counts": "true"})

    def list_channels(self, guild_id: str) -> List[Dict[str, Any]]:
        """List channels in a guild."""
        res = self._request("GET", f"/guilds/{guild_id}/channels")
        return res if isinstance(res, list) else []

    def get_channel_info(self, channel_id: str) -> Dict[str, Any]:
        """Fetch details for a single channel."""
        return self._request("GET", f"/channels/{channel_id}")

    def list_roles(self, guild_id: str) -> List[Dict[str, Any]]:
        """List roles defined in a guild."""
        res = self._request("GET", f"/guilds/{guild_id}/roles")
        return res if isinstance(res, list) else []

    def get_member_info(self, guild_id: str, user_id: str) -> Dict[str, Any]:
        """Fetch specific guild member information."""
        return self._request("GET", f"/guilds/{guild_id}/members/{user_id}")

    def search_members(self, guild_id: str, query: str, limit: int = 20) -> List[Dict[str, Any]]:
        """Search members by username or nickname prefix."""
        clamped_limit = max(1, min(100, limit))
        res = self._request("GET", f"/guilds/{guild_id}/members/search", params={"query": query, "limit": str(clamped_limit)})
        return res if isinstance(res, list) else []

    def fetch_messages(
        self,
        channel_id: str,
        limit: int = 50,
        before: Optional[str] = None,
        after: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        """Fetch recent messages from a channel."""
        params: Dict[str, str] = {"limit": str(max(1, min(100, limit)))}
        if before:
            params["before"] = before
        if after:
            params["after"] = after
        res = self._request("GET", f"/channels/{channel_id}/messages", params=params)
        return res if isinstance(res, list) else []

    def list_pins(self, channel_id: str) -> List[Dict[str, Any]]:
        """List pinned messages in a channel."""
        res = self._request("GET", f"/channels/{channel_id}/pins")
        return res if isinstance(res, list) else []

    def pin_message(self, channel_id: str, message_id: str) -> Dict[str, Any]:
        """Pin a message in a channel (reversible via unpin_message)."""
        self._request("PUT", f"/channels/{channel_id}/pins/{message_id}")
        return {"success": True, "action": "pin_message", "channel_id": channel_id, "message_id": message_id}

    def unpin_message(self, channel_id: str, message_id: str) -> Dict[str, Any]:
        """Unpin a message in a channel (reverses pin_message)."""
        self._request("DELETE", f"/channels/{channel_id}/pins/{message_id}")
        return {"success": True, "action": "unpin_message", "channel_id": channel_id, "message_id": message_id}

    def delete_message(self, channel_id: str, message_id: str) -> Dict[str, Any]:
        """Delete a message from a channel."""
        self._request("DELETE", f"/channels/{channel_id}/messages/{message_id}")
        return {"success": True, "action": "delete_message", "channel_id": channel_id, "message_id": message_id}

    def create_thread(
        self,
        channel_id: str,
        name: str,
        message_id: Optional[str] = None,
        auto_archive_duration: int = 1440,
    ) -> Dict[str, Any]:
        """Create a public thread from a message or channel."""
        path = f"/channels/{channel_id}/messages/{message_id}/threads" if message_id else f"/channels/{channel_id}/threads"
        body = {"name": name, "auto_archive_duration": auto_archive_duration}
        if not message_id:
            body["type"] = 11  # PUBLIC_THREAD
        res = self._request("POST", path, body=body)
        return {"success": True, "thread_id": res.get("id"), "name": res.get("name", name)}

    def add_role(self, guild_id: str, user_id: str, role_id: str) -> Dict[str, Any]:
        """Assign a role to a member (reversible via remove_role)."""
        self._request("PUT", f"/guilds/{guild_id}/members/{user_id}/roles/{role_id}")
        return {"success": True, "action": "add_role", "guild_id": guild_id, "user_id": user_id, "role_id": role_id}

    def remove_role(self, guild_id: str, user_id: str, role_id: str) -> Dict[str, Any]:
        """Remove a role from a member (reverses add_role)."""
        self._request("DELETE", f"/guilds/{guild_id}/members/{user_id}/roles/{role_id}")
        return {"success": True, "action": "remove_role", "guild_id": guild_id, "user_id": user_id, "role_id": role_id}
