"""Feishu/Lark document and comment integration adapter for Homun.

Supports reading document plain text and managing drive comments and replies.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional
import httpx

FEISHU_BASE_URL = "https://open.feishu.cn"
LARK_BASE_URL = "https://open.larksuite.com"


class FeishuError(Exception):
    """Base error for Feishu/Lark operations."""
    pass


class FeishuNotConfiguredError(FeishuError):
    """Raised when Feishu credentials or client are not configured."""
    pass


class FeishuAPIError(FeishuError):
    """Raised when the Feishu/Lark API returns a non-zero code or HTTP error."""
    def __init__(self, code: int, msg: str):
        super().__init__(f"Feishu API error {code}: {msg}")
        self.code = code
        self.msg = msg


class FeishuAdapter:
    """Adapter for Feishu / Lark document and drive comments API."""

    def __init__(
        self,
        tenant_access_token: str = "",
        is_lark: bool = False,
        base_url: Optional[str] = None,
        client: Optional[httpx.Client] = None,
    ) -> None:
        self.token = tenant_access_token.strip() if tenant_access_token else ""
        if base_url:
            self.base_url = base_url.rstrip("/")
        else:
            self.base_url = LARK_BASE_URL if is_lark else FEISHU_BASE_URL
        self._client = client

    def _get_headers(self) -> Dict[str, str]:
        if not self.token:
            raise FeishuNotConfiguredError("Feishu tenant access token is not configured")
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
    ) -> Dict[str, Any]:
        headers = self._get_headers()
        url = f"{self.base_url}{path}"
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
            raise FeishuError(f"Network error calling Feishu API: {exc}") from exc

        if resp.is_error:
            raise FeishuAPIError(resp.status_code, resp.text)

        payload = resp.json()
        code = payload.get("code")
        if code is not None and code != 0:
            raise FeishuAPIError(code, payload.get("msg", "Unknown Feishu error"))

        return payload

    def read_document(self, doc_token: str) -> str:
        """Read full plain-text content of a Feishu/Lark docx document."""
        token_clean = (doc_token or "").strip()
        if not token_clean:
            raise FeishuError("doc_token is required")

        path = f"/open-apis/docx/v1/documents/{token_clean}/raw_content"
        data = self._request("GET", path)
        content = data.get("data", {}).get("content", "")
        return content

    def list_comments(
        self,
        file_token: str,
        file_type: str = "docx",
        is_whole: bool = False,
        page_size: int = 100,
        page_token: str = "",
    ) -> Dict[str, Any]:
        """List comments on a document."""
        token_clean = (file_token or "").strip()
        if not token_clean:
            raise FeishuError("file_token is required")

        params: Dict[str, Any] = {
            "file_type": file_type or "docx",
            "user_id_type": "open_id",
            "page_size": max(1, min(100, page_size)),
        }
        if is_whole:
            params["is_whole"] = "true"
        if page_token:
            params["page_token"] = page_token

        path = f"/open-apis/drive/v1/files/{token_clean}/comments"
        return self._request("GET", path, params=params).get("data", {})

    def list_comment_replies(
        self,
        file_token: str,
        comment_id: str,
        page_size: int = 100,
        page_token: str = "",
    ) -> Dict[str, Any]:
        """List replies for a specific comment."""
        token_clean = (file_token or "").strip()
        cid_clean = (comment_id or "").strip()
        if not token_clean or not cid_clean:
            raise FeishuError("file_token and comment_id are required")

        params: Dict[str, Any] = {
            "user_id_type": "open_id",
            "page_size": max(1, min(100, page_size)),
        }
        if page_token:
            params["page_token"] = page_token

        path = f"/open-apis/drive/v1/files/{token_clean}/comments/{cid_clean}/replies"
        return self._request("GET", path, params=params).get("data", {})

    def add_comment(
        self,
        file_token: str,
        content: str,
        file_type: str = "docx",
    ) -> Dict[str, Any]:
        """Add a whole-document comment."""
        token_clean = (file_token or "").strip()
        text_clean = (content or "").strip()
        if not token_clean or not text_clean:
            raise FeishuError("file_token and content are required")

        body = {
            "comment": {
                "content": {
                    "elements": [
                        {
                            "type": "text_run",
                            "text_run": {"text": text_clean},
                        }
                    ]
                }
            }
        }
        params = {"file_type": file_type or "docx", "user_id_type": "open_id"}
        path = f"/open-apis/drive/v1/files/{token_clean}/new_comments"
        return self._request("POST", path, params=params, body=body).get("data", {})

    def reply_comment(
        self,
        file_token: str,
        comment_id: str,
        content: str,
    ) -> Dict[str, Any]:
        """Reply to a comment thread."""
        token_clean = (file_token or "").strip()
        cid_clean = (comment_id or "").strip()
        text_clean = (content or "").strip()
        if not token_clean or not cid_clean or not text_clean:
            raise FeishuError("file_token, comment_id, and content are required")

        body = {
            "content": {
                "elements": [
                    {
                        "type": "text_run",
                        "text_run": {"text": text_clean},
                    }
                ]
            }
        }
        path = f"/open-apis/drive/v1/files/{token_clean}/comments/{cid_clean}/replies"
        return self._request("POST", path, body=body).get("data", {})
