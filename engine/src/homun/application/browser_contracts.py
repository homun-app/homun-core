"""One owned headless browser. It is not the person's Chrome profile."""
from pydantic import BaseModel, ConfigDict, Field
from homun.models.agent_turn import ToolDefinition
from homun.tools.registry import ToolEntry


class BrowserReadArguments(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    url: str = Field(min_length=1, max_length=2000)


def entries(handler, version=1):
    if version == 1:
        description = (
            'Open one public http or https page in a private headless browser and return its visible text. '
            'The person\'s Chrome profile is not used. Private addresses are refused. '
            'The browser process is closed after the read. There is no login, no form filling, and no second tab.')
    elif version == 2:
        description = (
            'Open one public http or https page in a private headless browser and return its visible text. '
            'The person\'s Chrome profile is not used. Private addresses are refused. '
            'The browser process is closed after the read. There is no login, no form filling, and no second tab. '
            'A native dialog is dismissed without confirmation and its message is returned. Dialogs are not accepted.')
    else:
        raise ValueError('Unknown browser contract')
    definition = ToolDefinition(
        name='browser_read',
        description=description,
        input_schema=BrowserReadArguments.model_json_schema())
    def read_browser(ctx, actor, run, args):
        return handler(ctx, actor, run, 'browser_read', args)
    return [ToolEntry(definition, 'browser', str(version), BrowserReadArguments, read_browser, replay='read_only')]
