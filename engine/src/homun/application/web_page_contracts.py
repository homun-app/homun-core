"""Public web page tools. Search stays unavailable until a provider is configured."""
from pydantic import BaseModel, ConfigDict, Field
from homun.models.agent_turn import ToolDefinition
from homun.tools.registry import ToolEntry


class WebExtractArguments(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    url: str = Field(min_length=1, max_length=2000)


class WebSearchArguments(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    query: str = Field(min_length=1, max_length=500)


def entries(handler):
    extract = ToolDefinition(
        name='web_extract',
        description=(
            'Read one public http or https page and return bounded visible text. '
            'Private, loopback, and link-local addresses are refused. '
            'There is no browser, no login, and no search. A refusal or a failed fetch is not page content.'),
        input_schema=WebExtractArguments.model_json_schema())
    search = ToolDefinition(
        name='web_search',
        description=(
            'Web search is not configured. Calling it returns web_provider_unavailable and no results. '
            'Do not invent search results.'),
        input_schema=WebSearchArguments.model_json_schema())
    def extract_page(ctx, actor, run, args):
        return handler(ctx, actor, run, 'web_extract', args)
    def search_web(ctx, actor, run, args):
        return handler(ctx, actor, run, 'web_search', args)
    return [
        ToolEntry(extract, 'web_pages', '1', WebExtractArguments, extract_page, replay='read_only'),
        ToolEntry(search, 'web_pages', '1', WebSearchArguments, search_web, replay='read_only'),
    ]
