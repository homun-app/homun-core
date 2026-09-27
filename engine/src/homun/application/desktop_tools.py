"""Desktop and native OS computer-use tool contracts and dispatcher (H16 / C2).

Integrates ComputerUseDriver and OS bridges into supervised agent execution.
Never reports simulated success or fabricated window trees when the OS backend is unready.
"""
from __future__ import annotations

from typing import Any, Dict, List, Literal, Optional
from pydantic import BaseModel, ConfigDict, Field

from homun.application.computer_use_driver import ComputerUseDriver
from homun.application.desktop_contracts import (
    DesktopActionResult,
    DesktopCaptureResult,
    check_action_safety,
)
from homun.domain.errors import ValidationError
from homun.models.agent_turn import ToolDefinition
from homun.tools.registry import ToolEntry


class DesktopCaptureArguments(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    mode: Literal["som", "ax", "vision"] = "som"
    app: Optional[str] = None


class DesktopActArguments(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    action: str = Field(min_length=1, max_length=50)
    params: Dict[str, Any] = Field(default_factory=dict)


class DesktopAppsArguments(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class DesktopWindowsArguments(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    app: Optional[str] = None


class DesktopFocusArguments(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    app: str = Field(min_length=1, max_length=100)


def entries(handler, version: int = 1) -> List[ToolEntry]:
    if version != 1:
        raise ValueError("Unknown desktop tool contract version")

    shared = (
        "Operates directly on the host computer desktop via supervised OS drivers. "
        "Explicit permissions are required. Destructive shell injections and key combos are hard-blocked."
    )

    specs = [
        (
            "desktop_capture",
            DesktopCaptureArguments,
            "Capture the desktop UI elements or screenshot using Set-of-Marks (som), Accessibility (ax), or Vision mode. "
            + shared,
        ),
        (
            "desktop_act",
            DesktopActArguments,
            "Perform a pointer, click, type, key, or scroll action on the desktop. " + shared,
        ),
        (
            "desktop_apps",
            DesktopAppsArguments,
            "List currently running applications and their active status on the desktop. " + shared,
        ),
        (
            "desktop_windows",
            DesktopWindowsArguments,
            "List open windows and their coordinates for an application or across the desktop. " + shared,
        ),
        (
            "desktop_focus",
            DesktopFocusArguments,
            "Bring a specific application to the foreground. " + shared,
        ),
    ]

    catalog = []
    for name, model, desc in specs:
        definition = ToolDefinition(name=name, description=desc, input_schema=model.model_json_schema())

        def run_tool(ctx, actor, run, args, tool_name=name):
            return handler(ctx, actor, run, tool_name, args)

        catalog.append(ToolEntry(definition, "desktop", str(version), model, run_tool, replay="never"))

    return catalog


def execute(ctx, actor, run, tool: str, args: Dict[str, Any], *, driver: Optional[ComputerUseDriver] = None) -> Dict[str, Any]:
    desktop_run = run.get("desktop", {})
    if desktop_run.get("policy") != "native-desktop-v1" or desktop_run.get("version") != 1:
        raise ValidationError("Desktop computer use is not enabled for this run")

    drv = driver or getattr(ctx, "computer_use_driver", None) or ComputerUseDriver()

    status = drv.get_status()
    if not status.get("installed") or not status.get("ready"):
        return {
            "error_code": "desktop_backend_unavailable",
            "message": "Computer-use backend is not configured or platform permissions are missing",
            "status": status,
        }

    if tool == "desktop_capture":
        mode = args.get("mode", "som")
        app = args.get("app")
        cap = drv.capture(app=app, mode=mode)
        return {
            "mode": cap.mode,
            "width": cap.width,
            "height": cap.height,
            "elements_count": len(cap.elements),
            "elements": [
                {
                    "index": el.index,
                    "role": el.role,
                    "label": el.label,
                    "bounds": el.bounds,
                    "app": el.app,
                }
                for el in cap.elements
            ],
            "app": cap.app,
            "window_title": cap.window_title,
            "png_b64": cap.png_b64,
            "note": cap.note,
        }

    if tool == "desktop_act":
        action = args.get("action", "")
        params = args.get("params", {})
        safety_violation = check_action_safety(action, params)
        if safety_violation:
            return {
                "error_code": "desktop_safety_violation",
                "message": safety_violation,
            }
        res = drv.perform_action(action, params)
        return {
            "ok": res.ok,
            "action": res.action,
            "message": res.message,
            "code": res.code,
            "details": res.details,
        }

    if tool == "desktop_apps":
        apps = drv.list_apps()
        return {"apps": apps, "count": len(apps)}

    if tool == "desktop_windows":
        app = args.get("app")
        wins = drv.list_windows(app=app)
        return {"windows": wins, "count": len(wins)}

    if tool == "desktop_focus":
        app = args.get("app", "")
        fres = drv.focus_app(app)
        return {"ok": fres.ok, "app": fres.app, "error_code": fres.error_code}

    raise ValidationError(f"Unknown desktop tool: {tool}")
