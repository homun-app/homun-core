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


class WebSearchV3Arguments(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    query: str = Field(min_length=1, max_length=500)
    provider: str | None = Field(default=None, max_length=50)


class XSearchArguments(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    query: str = Field(min_length=1, max_length=500)
    allowed_x_handles: list[str] | None = Field(default=None, max_length=10)
    excluded_x_handles: list[str] | None = Field(default=None, max_length=10)
    from_date: str | None = Field(default=None, max_length=10)
    to_date: str | None = Field(default=None, max_length=10)


def entries(handler, version=1):
    extract_description = (
        'Read one public http or https page and return bounded visible text. '
        'Private, loopback, and link-local addresses are refused. '
        'There is no browser, no login, and no search. A refusal or a failed fetch is not page content.')
    if version == 3:
        extract_description = (
            'Read one public http or https page and return bounded visible text. Hits within TTL are served from cache. '
            'Private, loopback, and link-local addresses are refused. '
            'There is no browser, no login, and no search. A refusal or a failed fetch is not page content.')
    extract = ToolDefinition(
        name='web_extract',
        description=extract_description,
        input_schema=WebExtractArguments.model_json_schema())
    search_model = WebSearchArguments
    if version == 1:
        search_description = (
            'Web search is not configured. Calling it returns web_provider_unavailable and no results. '
            'Do not invent search results.')
    elif version == 2:
        search_description = (
            'Search the public web and return up to five titles, URLs, and snippets. '
            'Private addresses are omitted. An empty list means no public results were returned. '
            'Do not invent results. This is not a browser and it does not log in.')
    elif version == 3:
        search_model = WebSearchV3Arguments
        search_description = (
            'Search the public web and return up to five titles, URLs, and snippets. Hits within TTL are served from cache. '
            'If a configured provider fails, an eligible one-shot rescue is attempted. Private addresses are omitted. '
            'An empty list means no public results were returned. Do not invent results.')
    else:
        raise ValueError('Unknown web page contract')
    search = ToolDefinition(
        name='web_search',
        description=search_description,
        input_schema=search_model.model_json_schema())
    def extract_page(ctx, actor, run, args):
        return handler(ctx, actor, run, 'web_extract', args)
    def search_web(ctx, actor, run, args):
        return handler(ctx, actor, run, 'web_search', args)
    catalog = [
        ToolEntry(extract, 'web_pages', str(version), WebExtractArguments, extract_page, replay='read_only'),
        ToolEntry(search, 'web_pages', str(version), search_model, search_web, replay='read_only'),
    ]
    if version == 3:
        x_search_def = ToolDefinition(
            name='x_search',
            description=(
                "Search X (Twitter) posts, profiles, and threads using xAI's built-in X Search tool. "
                "Read-only discovery only. Requires configured xAI credentials."
            ),
            input_schema=XSearchArguments.model_json_schema(),
        )
        def run_x_search(ctx, actor, run, args):
            return handler(ctx, actor, run, 'x_search', args)
        catalog.append(ToolEntry(x_search_def, 'web_pages', '3', XSearchArguments, run_x_search, replay='read_only'))
    return catalog
