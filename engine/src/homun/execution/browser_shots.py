"""Save one PNG of the owned browser's current public page.

Captures a screenshot for visual inspection; saves the PNG
from the engine-owned browser and does not read the person's screen.
"""
import base64
import binascii
from pathlib import Path

from homun.execution.layout import confine_directory
from homun.execution.owned_browser import OwnedBrowser

_PNG = b"\x89PNG\r\n\x1a\n"
_LIMIT = 2_000_000


def _png_size(raw: bytes) -> tuple[int, int] | None:
    if len(raw) < 24 or raw[12:16] != b"IHDR":
        return None
    width = int.from_bytes(raw[16:20], "big")
    height = int.from_bytes(raw[20:24], "big")
    if not 1 <= width <= 10_000 or not 1 <= height <= 10_000:
        return None
    return width, height


def capture(browser: OwnedBrowser, dest: Path) -> dict:
    """Write a PNG of the current public page. The file is not the profile."""
    settled = browser.wait_document(dismiss_dialogs=True)
    if "error_code" in settled:
        return settled
    page = browser._page_socket()
    shot = page.call("Page.captureScreenshot", {"format": "png"})
    encoded = (shot.get("result") or {}).get("data")
    if not isinstance(encoded, str):
        return {"error_code": "web_fetch_failed", "message": "The browser did not return a screenshot"}
    try:
        raw = base64.b64decode(encoded, validate=True)
    except binascii.Error:
        return {"error_code": "web_fetch_failed", "message": "The browser did not return a screenshot"}
    size = _png_size(raw)
    if not raw.startswith(_PNG) or size is None or len(raw) > _LIMIT:
        return {"error_code": "web_fetch_failed", "message": "The screenshot was not a usable PNG"}
    try:
        directory = confine_directory(dest.parent)
    except OSError:
        return {"error_code": "browser_unavailable", "message": "The screenshot could not be saved"}
    path = directory / dest.name
    path.write_bytes(raw)
    width, height = size
    return {"url": settled["url"], "path": str(path), "bytes": len(raw), "width": width, "height": height}
