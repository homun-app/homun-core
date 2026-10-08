"""REST API router for Native Computer Use and Desktop UI surfaces (H16).

Exposes OS readiness, window enumeration, preview driving, annotation,
and guarded computer use input actions.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from homun.application.computer_use_driver import ComputerUseDriver
from homun.application.desktop_ui_manager import DesktopUiManager

router = APIRouter(prefix="/v1/desktop", tags=["desktop"])

_driver = ComputerUseDriver()
_ui_manager = DesktopUiManager()


def get_computer_use_driver() -> ComputerUseDriver:
    return _driver


def get_desktop_ui_manager() -> DesktopUiManager:
    return _ui_manager


# ── Schemas ─────────────────────────────────────────────────────────────

class ActionRequest(BaseModel):
    action: str
    params: Dict[str, Any] = Field(default_factory=dict)


class PreviewOpenRequest(BaseModel):
    url: str
    label: Optional[str] = ""


class PreviewDriveRequest(BaseModel):
    action: str
    ref: Optional[str] = None
    selector: Optional[str] = None
    text: Optional[str] = None
    key: Optional[str] = None


class PreviewAnnotateRequest(BaseModel):
    action: str = "add"
    ref: Optional[str] = None
    selector: Optional[str] = None
    label: Optional[str] = None


class TerminalBufferRequest(BaseModel):
    lines: List[str]


# ── Status & Windows Endpoints ──────────────────────────────────────────

@router.get("/status")
def desktop_status() -> Dict[str, Any]:
    """Read computer use readiness, permissions, and desktop UI availability."""
    driver_status = _driver.get_status()
    driver_status["ui_available"] = _ui_manager.is_available()
    return driver_status


@router.get("/apps")
def list_apps() -> Dict[str, Any]:
    """List running desktop applications."""
    return {"apps": _driver.list_apps()}


@router.get("/windows")
def list_windows(app: Optional[str] = None) -> Dict[str, Any]:
    """List open application windows."""
    return {"windows": _driver.list_windows(app=app)}


@router.post("/focus")
def focus_app(payload: Dict[str, str]) -> Dict[str, Any]:
    """Bring target application window to front."""
    app_name = payload.get("app")
    if not app_name:
        raise HTTPException(status_code=400, detail="app is required")
    res = _driver.focus_app(app_name)
    body = {
        "ok": res.ok,
        "message": res.message,
        "details": res.details,
        "code": getattr(res, "code", None),
    }
    if not res.ok:
        status = 503 if getattr(res, "code", None) == "backend_unavailable" else 404
        raise HTTPException(status_code=status, detail=body)
    return body


@router.post("/capture")
def capture_desktop(payload: Dict[str, Any]) -> Dict[str, Any]:
    """Capture screen or window state with visual element hierarchy."""
    app_name = payload.get("app")
    mode = payload.get("mode", "som")
    result = _driver.capture(app=app_name, mode=mode)
    return {
        "mode": result.mode,
        "width": result.width,
        "height": result.height,
        "app": result.app,
        "window_title": result.window_title,
        "png_b64": result.png_b64,
        "elements": [
            {
                "index": el.index,
                "role": el.role,
                "label": el.label,
                "bounds": el.bounds,
                "app": el.app,
                "pid": el.pid,
                "window_id": el.window_id,
            }
            for el in result.elements
        ],
        "note": result.note,
    }


@router.post("/act")
def perform_action(req: ActionRequest) -> Dict[str, Any]:
    """Execute a guarded pointer/keyboard action."""
    res = _driver.perform_action(req.action, req.params)
    body = {
        "ok": res.ok,
        "action": res.action,
        "message": res.message,
        "delivery_mode": res.delivery_mode,
        "details": res.details,
        "code": getattr(res, "code", None),
    }
    if not res.ok:
        status = 503 if getattr(res, "code", None) == "backend_unavailable" else 400
        raise HTTPException(status_code=status, detail=body)
    return body


# ── Desktop Window & Terminal Endpoints ─────────────────────────────────

@router.get("/window-below")
def read_window_below() -> Dict[str, Any]:
    """Read OS window sitting directly behind the desktop app."""
    return _ui_manager.read_window_below()


@router.post("/terminal/buffer")
def set_terminal_buffer(req: TerminalBufferRequest) -> Dict[str, Any]:
    """Inject xterm terminal buffer lines for inspection."""
    _ui_manager.set_terminal_buffer(req.lines)
    return {"ok": True, "lines_count": len(req.lines)}


@router.get("/terminal")
def read_terminal(start_line: Optional[int] = None, count: Optional[int] = None) -> Dict[str, Any]:
    """Read lines and scrollback from the desktop terminal pane."""
    res = _ui_manager.read_terminal(start_line=start_line, count=count)
    if not res["ok"]:
        raise HTTPException(status_code=400, detail=res["error"])
    return res


# ── Preview Pane & Driving Endpoints ────────────────────────────────────

@router.post("/preview/open")
def preview_open(req: PreviewOpenRequest) -> Dict[str, Any]:
    """Open a URL or file in the desktop preview pane."""
    return _ui_manager.preview_open(url=req.url, label=req.label or "")


@router.post("/preview/close")
def preview_close(payload: Dict[str, Optional[str]]) -> Dict[str, Any]:
    """Close one or all tabs in the preview pane."""
    return _ui_manager.preview_close(url=payload.get("url"))


@router.get("/preview/read")
def preview_read(url: Optional[str] = None, start: int = 0, count: int = 2000) -> Dict[str, Any]:
    """Read rendered text content from the preview pane."""
    res = _ui_manager.preview_read(url=url, start=start, count=count)
    if not res["ok"]:
        raise HTTPException(status_code=400, detail=res["error"])
    return res


@router.post("/preview/drive")
def drive_preview(req: PreviewDriveRequest) -> Dict[str, Any]:
    """Drive preview browser interactions (click, type, scroll, elements)."""
    res = _ui_manager.drive_preview(
        action=req.action,
        ref=req.ref,
        selector=req.selector,
        text=req.text,
        key=req.key,
    )
    if not res["ok"]:
        status = 503 if res.get("code") == "backend_unavailable" else 400
        raise HTTPException(status_code=status, detail=res)
    return res


@router.post("/preview/annotate")
def annotate_preview(req: PreviewAnnotateRequest) -> Dict[str, Any]:
    """Outline or mark elements permanently in the preview pane."""
    res = _ui_manager.annotate_preview(
        action=req.action,
        ref=req.ref,
        selector=req.selector,
        label=req.label,
    )
    if not res["ok"]:
        raise HTTPException(status_code=400, detail=res["error"])
    return res
