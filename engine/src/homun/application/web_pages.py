"""Dispatch the public-page tools pinned to one run."""
from homun.domain.errors import ValidationError
from homun.execution.web_pages import fetch_page, search_public


def execute(ctx, actor, run, tool, args):
    if run.get('web_pages', {}).get('policy') != 'public-http-v1':
        raise ValidationError('Web pages are not enabled for this run')
    version = run.get('web_pages', {}).get('version', 1)
    if tool == 'web_extract':
        if version >= 3:
            from homun.execution.web_cache import cached_fetch_page
            return cached_fetch_page(args['url'])
        return fetch_page(args['url'])
    if tool == 'web_search':
        if version == 1:
            return {
                'error_code': 'web_provider_unavailable',
                'message': 'No web search provider is configured. Do not invent results.',
            }
        if version == 2:
            return search_public(args['query'])
        from homun.execution.web_providers import search_with_rescue
        return search_with_rescue(args['query'], provider=args.get('provider'))
    if tool == 'x_search' and version >= 3:
        from homun.execution.x_search import search_x
        return search_x(
            args['query'],
            allowed_handles=args.get('allowed_x_handles'),
            excluded_handles=args.get('excluded_x_handles'),
            from_date=args.get('from_date'),
            to_date=args.get('to_date'),
        )
    raise ValidationError('Unknown web tool')
