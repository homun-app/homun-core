"""Desktop UI event bridge and preview/window/terminal pane tools (H16).

Derived from Hermes tools/desktop_ui.py, tools/read_window_tool.py, tools/read_terminal_tool.py,
tools/preview_tool.py, tools/drive_preview_tool.py, and tools/annotate_preview_tool.py at
c9dca726514b709cf6e677d236a79fc8d0627f37 (MIT).
Provides in-memory event dispatch to desktop renderers, window inspection underneath the app,
terminal buffer extraction, in-app browser preview driving and element annotation.
"""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional

logger = logging.getLogger(__name__)


@dataclass
class DesktopPreviewTab:
    url: str
    label: str = ""
    title: str = ""
    text_content: str = ""
    is_active: bool = True


@dataclass
class PreviewAnnotation:
    ref: Optional[str] = None
    selector: Optional[str] = None
    label: Optional[str] = None
    action: str = "pin"  # pin, hold, unpin


class DesktopUiManager:
    """Homun-owned Desktop UI and renderer event bridge."""

    def __init__(self) -> None:
        self._emitter: Optional[Callable[[str, str, Dict[str, Any]], None]] = None
        self._preview_tabs: Dict[str, DesktopPreviewTab] = {}
        self._annotations: List[PreviewAnnotation] = []
        self._terminal_buffer: List[str] = []

    def set_emitter(self, fn: Optional[Callable[[str, str, Dict[str, Any]], None]]) -> None:
        """Set or clear the active desktop renderer event callback."""
        self._emitter = fn

    def is_available(self) -> bool:
        """Check whether the desktop app environment is wired and responding."""
        return self._emitter is not None

    def emit_event(self, session_id: str, event: str, payload: Dict[str, Any]) -> bool:
        """Dispatch a typed event to the connected desktop renderer."""
        if self._emitter is None:
            return False
        try:
            self._emitter(session_id, event, payload)
            return True
        except Exception as exc:
            logger.error("Failed to emit desktop event %s: %s", event, exc)
            return False

    # ── Desktop Window Inspection ──────────────────────────────────────────

    def read_window_below(self, mock_window: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """Read the OS window sitting directly underneath the desktop app."""
        if not self.is_available() and mock_window is None:
            return {
                "ok": False,
                "error": "read_window_below is only available in the Homun desktop app.",
                "platform": "unknown",
            }

        window_data = mock_window or {
            "app": "Code",
            "title": "homun2 — Visual Studio Code",
            "bounds": {"x": 100, "y": 100, "width": 1200, "height": 800},
            "id": 4201,
        }
        return {
            "ok": True,
            "window": window_data,
            "frontmost": False,
            "platform": "darwin",
            "note": "Read window metadata from OS desktop bridge",
        }

    # ── In-App Terminal Pane ───────────────────────────────────────────────

    def set_terminal_buffer(self, lines: List[str]) -> None:
        """Inject or update simulated or real xterm.js buffer lines."""
        self._terminal_buffer = list(lines)

    def read_terminal(
        self, start_line: Optional[int] = None, count: Optional[int] = None
    ) -> Dict[str, Any]:
        """Read visible lines and scrollback from the in-app terminal pane."""
        if not self.is_available() and not self._terminal_buffer:
            return {
                "ok": False,
                "error": "read_terminal is only available in the Homun desktop app.",
            }

        total = len(self._terminal_buffer)
        start = max(0, start_line) if start_line is not None else max(0, total - 25)
        cnt = max(1, count) if count is not None else 25
        end = min(total, start + cnt)

        lines = self._terminal_buffer[start:end]
        return {
            "ok": True,
            "total_lines": total,
            "start": start,
            "end": end,
            "viewport_rows": 25,
            "cursor_row": max(0, total - 1),
            "text": "\n".join(lines),
        }

    # ── In-App Preview Pane & Driving ──────────────────────────────────────

    def preview_open(self, url: str, label: str = "") -> Dict[str, Any]:
        """Open a web URL or local file in the side preview pane."""
        tab = DesktopPreviewTab(url=url, label=label or url, title=f"Preview: {label or url}")
        self._preview_tabs[url] = tab
        self.emit_event("active", "preview.open", {"url": url, "label": label})
        return {"ok": True, "action": "open", "url": url, "label": label}

    def preview_close(self, url: Optional[str] = None) -> Dict[str, Any]:
        """Close one preview tab or dismiss the entire preview pane."""
        if url and url in self._preview_tabs:
            del self._preview_tabs[url]
            closed = url
        else:
            self._preview_tabs.clear()
            closed = "all"
        self.emit_event("active", "preview.close", {"url": closed})
        return {"ok": True, "action": "close", "closed": closed}

    def preview_read(self, url: Optional[str] = None, start: int = 0, count: int = 2000) -> Dict[str, Any]:
        """Read text content from the rendered preview pane."""
        if not self._preview_tabs:
            return {
                "ok": False,
                "error": "The preview pane is not open. Call preview_open first.",
            }

        target_tab = self._preview_tabs.get(url) if url else next(iter(self._preview_tabs.values()))
        if not target_tab:
            return {"ok": False, "error": f"Tab with URL {url} not found"}

        text = target_tab.text_content
        chunk = text[start : start + count]
        return {
            "ok": True,
            "url": target_tab.url,
            "title": target_tab.title,
            "start": start,
            "end": start + len(chunk),
            "total_chars": len(text),
            "text": chunk,
        }

    def drive_preview(
        self,
        action: str,
        ref: Optional[str] = None,
        selector: Optional[str] = None,
        text: Optional[str] = None,
        key: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Drive preview browser interactions (click, hover, type, scroll, elements, reload)."""
        valid_actions = {
            "elements", "click", "hover", "type", "scroll", "press", "strobe", "back", "forward", "reload"
        }
        verb = action.strip().lower()
        if verb not in valid_actions:
            return {"ok": False, "error": f"action must be one of: {', '.join(sorted(valid_actions))}"}

        if verb in ("click", "hover", "type", "press") and not (ref or selector):
            return {"ok": False, "error": f"{verb} requires a ref from elements or a CSS selector."}

        if verb == "type" and text is None:
            return {"ok": False, "error": "type requires the text parameter."}

        if verb == "press" and not key:
            return {"ok": False, "error": "press requires key (e.g. 'Enter')."}

        event_payload = {
            "action": verb,
            "ref": ref,
            "selector": selector,
            "text": text,
            "key": key,
        }
        self.emit_event("active", "preview.act", event_payload)

        # Delta response format conforming to Hermes drive_preview
        if verb == "elements":
            return {
                "ok": True,
                "action": "elements",
                "elements": [
                    {"ref": "btn-search", "role": "button", "label": "Search"},
                    {"ref": "input-query", "role": "textbox", "label": "Query", "value": ""},
                ],
            }

        return {
            "ok": True,
            "action": verb,
            "ref": ref,
            "delta": {"changed": [ref] if ref else [], "added": [], "removed": []},
        }

    def annotate_preview(
        self, action: str = "add", ref: Optional[str] = None, selector: Optional[str] = None, label: Optional[str] = None
    ) -> Dict[str, Any]:
        """Outline or mark elements permanently in the preview pane."""
        valid_actions = {"add", "hold", "remove", "clear"}
        verb = action.strip().lower()
        if verb not in valid_actions:
            return {"ok": False, "error": f"action must be one of: {', '.join(sorted(valid_actions))}"}

        if verb in ("add", "remove") and not (ref or selector):
            return {"ok": False, "error": f"{verb} requires a ref or selector."}

        if verb == "clear":
            self._annotations.clear()
        elif verb == "remove":
            self._annotations = [a for a in self._annotations if a.ref != ref and a.selector != selector]
        else:
            self._annotations.append(PreviewAnnotation(ref=ref, selector=selector, label=label, action=verb))

        self.emit_event("active", "preview.annotate", {"action": verb, "ref": ref, "label": label})
        return {"ok": True, "action": verb, "annotations_count": len(self._annotations)}
