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
        connected: bool = True,
        mock_members_provider: Optional[Any] = None,
        mock_sticker_catalog: Optional[List[Dict[str, str]]] = None,
    ) -> None:
        self.connected = connected
        self._members_provider = mock_members_provider
        self._sticker_catalog = mock_sticker_catalog or [
            {"sticker_id": "stk_thumbs_up", "name": "点赞", "description": "Thumbs up"},
            {"sticker_id": "stk_celebrate", "name": "庆祝", "description": "Celebration party"},
            {"sticker_id": "stk_heart", "name": "爱心", "description": "Love heart"},
            {"sticker_id": "stk_thinking", "name": "思考", "description": "Thinking face"},
        ]

    def _ensure_connected(self) -> None:
        if not self.connected:
            raise YuanbaoNotConnectedError("Yuanbao platform adapter is not connected")

    def get_group_info(self, group_code: str) -> Dict[str, Any]:
        """Fetch group metadata and member counts."""
        self._ensure_connected()
        code_clean = (group_code or "").strip()
        if not code_clean:
            raise YuanbaoError("group_code is required")
        return {
            "success": True,
            "group_code": code_clean,
            "group_name": f"Group-{code_clean}",
            "member_count": 42,
            "owner_user_id": "user_owner_01",
        }

    def query_group_members(self, group_code: str, query: str = "") -> List[Dict[str, Any]]:
        """List or search group members by name or nickname."""
        self._ensure_connected()
        code_clean = (group_code or "").strip()
        if not code_clean:
            raise YuanbaoError("group_code is required")

        if callable(self._members_provider):
            members = self._members_provider(code_clean)
        else:
            members = [
                {"user_id": "u1", "nickname": "Alice", "role": "admin"},
                {"user_id": "u2", "nickname": "Bob", "role": "member"},
                {"user_id": "u3", "nickname": "Charlie", "role": "member"},
                {"user_id": "u4", "nickname": "Alice Zhang", "role": "member"},
            ]

        if not query:
            return members

        q_lower = query.strip().lower()
        return [m for m in members if q_lower in str(m.get("nickname", "")).lower()]

    def search_sticker(self, query: str) -> List[Dict[str, str]]:
        """Search available platform stickers by name or description."""
        self._ensure_connected()
        q_clean = (query or "").strip().lower()
        if not q_clean:
            return self._sticker_catalog

        return [
            s for s in self._sticker_catalog
            if q_clean in s.get("name", "").lower() or q_clean in s.get("description", "").lower()
        ]

    def send_sticker(self, group_code: str, sticker_id: str) -> Dict[str, Any]:
        """Send a sticker to a group."""
        self._ensure_connected()
        code_clean = (group_code or "").strip()
        stk_clean = (sticker_id or "").strip()
        if not code_clean or not stk_clean:
            raise YuanbaoError("group_code and sticker_id are required")

        return {
            "success": True,
            "action": "send_sticker",
            "group_code": code_clean,
            "sticker_id": stk_clean,
            "delivered": True,
        }

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
        """Send a direct message to a user resolved from group members."""
        self._ensure_connected()
        code_clean = (group_code or "").strip()
        text_clean = (content or "").strip()
        if not code_clean or not text_clean:
            raise YuanbaoError("group_code and content are required")

        resolved_user_id, resolved_name = self.resolve_recipient(code_clean, user_id, name)
        mention_token = format_mention(resolved_name)

        return {
            "success": True,
            "action": "send_dm",
            "group_code": code_clean,
            "recipient_user_id": resolved_user_id,
            "recipient_name": resolved_name,
            "mention": mention_token,
            "content": text_clean,
            "delivered": True,
        }
