"""Dispatch the public-page tools pinned to one run."""
from homun.domain.errors import ValidationError
from homun.execution.web_pages import fetch_page, search_public


def execute(ctx, actor, run, tool, args):
    if run.get('web_pages', {}).get('policy') != 'public-http-v1':
        raise ValidationError('Web pages are not enabled for this run')
    if tool == 'web_extract':
        return fetch_page(args['url'])
    if tool == 'web_search':
        if run['web_pages'].get('version') == 1:
            return {
                'error_code': 'web_provider_unavailable',
                'message': 'No web search provider is configured. Do not invent results.',
            }
        return search_public(args['query'])
    raise ValidationError('Unknown web tool')
