"""Conservative interpretation of adapter delivery acknowledgements."""
from typing import Any, Dict


def delivery_status(response: Dict[str, Any], *, has_media: bool) -> str:
    """False with a transport error is ambiguous: the peer may have accepted it."""
    if response.get("delivery_state") in {"unknown", "pending"}:
        return "unknown"
    if response.get("delivered") is True:
        code = response.get('status_code')
        if (response.get('delivery_state') == 'failed' or response.get('status') == 'failed'
                or (isinstance(code, int) and code >= 400) or response.get('error')):
            return 'unknown'
        # Message delivery and requested media_count do not prove attachment upload.
        if has_media and response.get("media_delivered") is not True:
            return "unknown"
        return "delivered"
    if response.get("delivery_state") == "failed":
        return "failed"
    if response.get("delivered") is False:
        code = response.get("status_code")
        if isinstance(code, int) and 400 <= code < 500 and code != 408:
            return "failed"
        if not response.get("error"):
            return "failed"
        # Base ChannelAdapter refuses before any transport is attempted.
        if "Refusing to report delivery without a real outbound client" in str(response.get("error")):
            return "failed"
    return "unknown"
