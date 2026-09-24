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


def entries(handler, version=1):
    extract = ToolDefinition(
        name='web_extract',
        description=(
            'Read one public http or https page and return bounded visible text. '
            'Private, loopback, and link-local addresses are refused. '
            'There is no browser, no login, and no search. A refusal or a failed fetch is not page content.'),
        input_schema=WebExtractArguments.model_json_schema())
    if version == 1:
        search_description = (
            'Web search is not configured. Calling it returns web_provider_unavailable and no results. '
            'Do not invent search results.')
    elif version == 2:
        search_description = (
            'Search the public web and return up to five titles, URLs, and snippets. '
            'Private addresses are omitted. An empty list means no public results were returned. '
            'Do not invent results. This is not a browser and it does not log in.')
    else:
        raise ValueError('Unknown web page contract')
    search = ToolDefinition(
        name='web_search',
        description=search_description,
        input_schema=WebSearchArguments.model_json_schema())
    def extract_page(ctx, actor, run, args):
        return handler(ctx, actor, run, 'web_extract', args)
    def search_web(ctx, actor, run, args):
        return handler(ctx, actor, run, 'web_search', args)
    return [
        ToolEntry(extract, 'web_pages', str(version), WebExtractArguments, extract_page, replay='read_only'),
        ToolEntry(search, 'web_pages', str(version), WebSearchArguments, search_web, replay='read_only'),
    ]
