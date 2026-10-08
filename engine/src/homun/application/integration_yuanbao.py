"""Tencent Yuanbao (元宝) platform integration adapter for Homun.

Provides group info, member querying, sticker search/dispatch, and targeted DM messaging
with nickname disambiguation and standardized mention syntax formatting.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple


class YuanbaoError(Exception):
    """Base exception for Yuanbao platform operations."""
    pass


class YuanbaoNotConnectedError(YuanbaoError):
    """Raised when the Yuanbao adapter or bridge is not connected."""
    pass


class YuanbaoAmbiguousRecipientError(YuanbaoError):
    """Raised when a recipient name matches multiple group members."""
    def __init__(self, message: str, candidates: List[Dict[str, Any]]):
        super().__init__(message)
        self.candidates = candidates


def format_mention(nickname: str) -> str:
    """Format an @mention token per Yuanbao platform requirements: ' @nickname '."""
    clean = nickname.strip()
    return f" @{clean} "


class YuanbaoAdapter:
    """Adapter for Yuanbao platform group and messaging actions."""

    def __init__(
        self,
        connected: bool = False,
        members_provider: Optional[Any] = None,
        sticker_catalog: Optional[List[Dict[str, str]]] = None,
        group_info_provider: Optional[Any] = None,
        # Deprecated aliases kept for older tests that inject fixtures explicitly.
        mock_members_provider: Optional[Any] = None,
        mock_sticker_catalog: Optional[List[Dict[str, str]]] = None,
    ) -> None:
        self.connected = connected
        self._members_provider = members_provider or mock_members_provider
        self._group_info_provider = group_info_provider
        self._sticker_catalog = sticker_catalog or mock_sticker_catalog

    def _ensure_connected(self) -> None:
        if not self.connected:
            raise YuanbaoNotConnectedError("Yuanbao platform adapter is not connected")

    def get_group_info(self, group_code: str) -> Dict[str, Any]:
        """Fetch group metadata and member counts from a configured provider."""
        self._ensure_connected()
        code_clean = (group_code or "").strip()
        if not code_clean:
            raise YuanbaoError("group_code is required")
        if not callable(self._group_info_provider):
            raise YuanbaoError(
                "Yuanbao group_info_provider is not configured; refusing to invent group metadata."
            )
        return self._group_info_provider(code_clean)

    def query_group_members(self, group_code: str, query: str = "") -> List[Dict[str, Any]]:
        """List or search group members by name or nickname."""
        self._ensure_connected()
        code_clean = (group_code or "").strip()
        if not code_clean:
            raise YuanbaoError("group_code is required")

        if not callable(self._members_provider):
            raise YuanbaoError(
                "Yuanbao members_provider is not configured; refusing to invent member lists."
            )
        members = self._members_provider(code_clean)

        if not query:
            return members

        q_lower = query.strip().lower()
        return [m for m in members if q_lower in str(m.get("nickname", "")).lower()]

    def search_sticker(self, query: str) -> List[Dict[str, str]]:
        """Search available platform stickers by name or description."""
        self._ensure_connected()
        if self._sticker_catalog is None:
            raise YuanbaoError(
                "Yuanbao sticker catalog is not configured; refusing to invent stickers."
            )
        q_clean = (query or "").strip().lower()
        if not q_clean:
            return self._sticker_catalog

        return [
            s for s in self._sticker_catalog
            if q_clean in s.get("name", "").lower() or q_clean in s.get("description", "").lower()
        ]

    def send_sticker(self, group_code: str, sticker_id: str) -> Dict[str, Any]:
        """Send a sticker to a group via a configured transport only."""
        self._ensure_connected()
        code_clean = (group_code or "").strip()
        stk_clean = (sticker_id or "").strip()
        if not code_clean or not stk_clean:
            raise YuanbaoError("group_code and sticker_id are required")
        raise YuanbaoError(
            "Yuanbao outbound transport is not configured; refusing to report sticker delivery."
        )

    def resolve_recipient(
        self,
        group_code: str,
        user_id: Optional[str] = None,
        name: Optional[str] = None,
    ) -> Tuple[str, str]:
        """Resolve a recipient user_id and nickname, enforcing disambiguation."""
        if user_id:
            return user_id.strip(), name or user_id.strip()

        if not name:
            raise YuanbaoError("Either user_id or name is required to resolve recipient")

        matches = self.query_group_members(group_code, query=name)
        if not matches:
            raise YuanbaoError(f"No group member matching '{name}' found in group {group_code}")

        if len(matches) > 1:
            exact = [m for m in matches if m.get("nickname", "").strip().lower() == name.strip().lower()]
            if len(exact) == 1:
                return exact[0]["user_id"], exact[0]["nickname"]
            raise YuanbaoAmbiguousRecipientError(
                f"Multiple members match '{name}', please disambiguate",
                candidates=matches,
            )

        return matches[0]["user_id"], matches[0].get("nickname", name)

    def send_dm(
        self,
        group_code: str,
        content: str,
        user_id: Optional[str] = None,
        name: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Send a direct message once a transport is configured."""
        self._ensure_connected()
        code_clean = (group_code or "").strip()
        text_clean = (content or "").strip()
        if not code_clean or not text_clean:
            raise YuanbaoError("group_code and content are required")

        resolved_user_id, resolved_name = self.resolve_recipient(code_clean, user_id, name)
        raise YuanbaoError(
            f"Yuanbao outbound transport is not configured for recipient "
            f"{resolved_user_id}/{resolved_name}; refusing to report DM delivery."
        )
