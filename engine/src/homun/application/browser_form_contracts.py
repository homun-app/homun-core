"""Owned browser session that can fill one public form. Version 4 can also save a PNG."""
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


def entries(handler, version=3):
    if version not in {3, 4}:
        raise ValueError('Unknown browser contract')
    shared = (
        'Use the private headless browser for this run. The person\'s Chrome profile is not used. '
        'Private addresses are refused. A native dialog is dismissed without confirmation and is not accepted. '
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
    if version == 4:
        specs.append((
            'browser_screenshot', BrowserEmptyArguments,
            'Save a PNG of the current public page in the private browser. It is not a screenshot of the person\'s screen. ' + shared,
        ))
    catalog = []
    for name, model, description in specs:
        definition = ToolDefinition(name=name, description=description, input_schema=model.model_json_schema())
        def run_tool(ctx, actor, run, args, tool_name=name):
            return handler(ctx, actor, run, tool_name, args)
        catalog.append(ToolEntry(definition, 'browser', str(version), model, run_tool, replay='never'))
    return catalog
