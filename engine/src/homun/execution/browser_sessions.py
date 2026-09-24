"""One live owned browser for a run.

A restarted engine does not reattach to the process. Closing it signals only
that process group and removes the engine-owned profile.
"""
import shutil
from pathlib import Path

from homun.execution.owned_browser import OwnedBrowser
from homun.execution.web_pages import PageRefusal

_OPEN: dict[str, OwnedBrowser] = {}


def _key(run_id: str) -> str:
    if (not isinstance(run_id, str) or not 1 <= len(run_id) <= 80
            or any(char not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-" for char in run_id)):
        raise PageRefusal("browser_unavailable", "The browser session is not available")
    return run_id


def open_browser(data_dir: Path, run_id: str) -> OwnedBrowser:
    key = _key(run_id)
    current = _OPEN.get(key)
    if current is not None and current.process.poll() is None:
        return current
    if current is not None:
        current.close()
    browser = OwnedBrowser(Path(data_dir) / "execution" / "browsers" / key)
    if "Application Support/Google/Chrome" in " ".join(browser.argv):
        browser.close()
        raise PageRefusal("browser_unavailable", "The person's browser profile was refused")
    _OPEN[key] = browser
    return browser


def require_browser(run_id: str) -> OwnedBrowser | None:
    try:
        key = _key(run_id)
    except PageRefusal:
        return None
    current = _OPEN.get(key)
    if current is None or current.process.poll() is not None:
        return None
    return current


def close_browser(run_id: str) -> None:
    try:
        key = _key(run_id)
    except PageRefusal:
        return
    browser = _OPEN.pop(key, None)
    if browser is None:
        return
    root = browser.root
    browser.close()
    shutil.rmtree(root, ignore_errors=True)
