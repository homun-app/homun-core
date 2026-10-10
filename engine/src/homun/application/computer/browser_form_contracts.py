from typing import Literal, Optional
from pydantic import BaseModel, ConfigDict, Field
from homun.models.agent_turn import ToolDefinition
from homun.tools.registry import ToolEntry


class BrowserOpenArguments(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    url: str = Field(min_length=1, max_length=2000)


class BrowserEmptyArguments(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)


class BrowserRefArguments(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    ref: str = Field(pattern=r'^@e[1-9][0-9]{0,3}$')


class BrowserTypeArguments(BrowserRefArguments):
    text: str = Field(max_length=2000)


class BrowserPressArguments(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    key: str = Field(min_length=1, max_length=20)


class BrowserDialogArguments(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    action: Literal['accept', 'dismiss', 'inspect'] = 'inspect'
    prompt_text: str = Field(default='', max_length=500)


class BrowserConsoleArguments(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    clear: bool = False


class BrowserScrollArguments(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    direction: Literal['up', 'down', 'left', 'right'] = 'down'
    amount: int = Field(default=300, ge=1, le=10000)
    ref: Optional[str] = Field(default=None, pattern=r'^@e[1-9][0-9]{0,3}$')


class BrowserVisionArguments(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    format: Literal['jpeg', 'png'] = 'jpeg'
    quality: int = Field(default=75, ge=10, le=100)
    ref: Optional[str] = Field(default=None, pattern=r'^@e[1-9][0-9]{0,3}$')


class BrowserProfileArguments(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    action: Literal['status', 'clear_cookies', 'clear_cache'] = 'status'


def entries(handler, version=3):
    if version not in {3, 4, 5, 6}:
        raise ValueError('Unknown browser contract')
    shared = (
        'Use the private headless browser for this run. The person\'s Chrome profile is not used. '
        'Private addresses are refused. A native dialog is dismissed without confirmation and is not accepted by default. '
        'There is no login and no second tab. The browser process stays open until browser_close or the run ends.'
    )
    if version >= 5:
        shared = (
            'Use the private headless browser for this run. The person\'s Chrome profile is not used. '
            'Private addresses are refused. Controls inside public frames are included. '
            'There is no login and no second tab. The browser process stays open until browser_close or the run ends.'
        )
    specs = [
        ('browser_open', BrowserOpenArguments,
         'Open one public http or https page and return its text plus refs for interactive controls. ' + shared),
        ('browser_snapshot', BrowserEmptyArguments,
         'Refresh refs for the interactive controls on the current public page. ' + shared),
        ('browser_type', BrowserTypeArguments,
         'Clear one text field identified by a snapshot ref and set its value. The value is not echoed. ' + shared),
        ('browser_click', BrowserRefArguments,
         'Click one control identified by a snapshot ref, then return the resulting public page. ' + shared),
        ('browser_press', BrowserPressArguments,
         'Press one key: Enter, Tab, Escape, Backspace, an arrow, or a single letter or digit. ' + shared),
        ('browser_close', BrowserEmptyArguments,
         'Close the private browser started for this run. Only that process is stopped. ' + shared),
    ]
    if version in {4, 5, 6}:
        specs.append((
            'browser_screenshot', BrowserEmptyArguments,
            'Save a PNG of the current public page in the private browser. It is not a screenshot of the person\'s screen. ' + shared,
        ))
    if version == 6:
        specs.extend([
            ('browser_dialog', BrowserDialogArguments,
             'Inspect or respond to a native JavaScript dialog (alert, confirm, prompt). ' + shared),
            ('browser_console', BrowserConsoleArguments,
             'Retrieve or clear captured console logs and uncaught runtime errors from the public page. ' + shared),
            ('browser_scroll', BrowserScrollArguments,
             'Scroll the current public page by direction and amount, or scroll a specific ref control into view. ' + shared),
            ('browser_vision', BrowserVisionArguments,
             'Capture a compressed screenshot (JPEG/PNG) optimized for multimodal vision and token budgeting. ' + shared),
            ('browser_profile', BrowserProfileArguments,
             'Inspect isolated browser profile storage or clear cookies and cache for the run. ' + shared),
        ])
    catalog = []
    for name, model, description in specs:
        definition = ToolDefinition(name=name, description=description, input_schema=model.model_json_schema())
        def run_tool(ctx, actor, run, args, tool_name=name):
            return handler(ctx, actor, run, tool_name, args)
        catalog.append(ToolEntry(definition, 'browser', str(version), model, run_tool, replay='never'))
    return catalog
