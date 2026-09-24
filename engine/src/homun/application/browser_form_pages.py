"""Dispatch form actions for one owned browser session."""
from pathlib import Path
from secrets import token_hex

from homun.domain.errors import ValidationError
from homun.execution.browser_forms import click, fill, open_page, press, snapshot
from homun.execution.browser_sessions import close_browser, open_browser, require_browser
from homun.execution.browser_shots import capture
from homun.execution.owned_browser import chrome_path
from homun.execution.web_pages import PageRefusal, _classify


def _call_id(run):
    """The unresolved native tool call, so a replay returns the stored effect."""
    answered = {message.get('tool_call_id') for message in run.get('_messages') or [] if message.get('role') == 'tool'}
    for message in run.get('_messages') or []:
        for call in message.get('tool_calls') or []:
            if call.get('id') not in answered:
                return call.get('id')
    return None


def _once(browser, run, action):
    call_id = _call_id(run)
    if call_id and call_id in browser.receipts:
        return browser.receipts[call_id]
    result = action()
    if call_id:
        browser.receipts[call_id] = result
    return result


def execute(ctx, actor, run, tool, args):
    browser_run = run.get('browser', {})
    if browser_run.get('policy') != 'owned-headless-v1' or browser_run.get('version') not in {3, 4}:
        raise ValidationError('The browser is not enabled for this run')
    if tool == 'browser_close':
        close_browser(run['id'])
        return {'closed': True}
    if tool == 'browser_open':
        try:
            _classify(args['url'])
        except PageRefusal as exc:
            return {'error_code': exc.code, 'message': exc.message}
        if chrome_path() is None:
            return {'error_code': 'browser_unavailable', 'message': 'No owned browser is installed'}
        try:
            browser = open_browser(ctx.data_dir, run['id'])
        except PageRefusal as exc:
            return {'error_code': exc.code, 'message': exc.message}
        return _once(browser, run, lambda: open_page(browser, args['url']))
    browser = require_browser(run['id'])
    if browser is None:
        return {'error_code': 'browser_unavailable', 'message': 'The browser session is not open'}
    if tool == 'browser_snapshot':
        return _once(browser, run, lambda: snapshot(browser))
    if tool == 'browser_type':
        return _once(browser, run, lambda: fill(browser, args['ref'], args['text']))
    if tool == 'browser_click':
        return _once(browser, run, lambda: click(browser, args['ref']))
    if tool == 'browser_press':
        return _once(browser, run, lambda: press(browser, args['key']))
    if tool == 'browser_screenshot' and browser_run.get('version') == 4:
        dest = Path(ctx.data_dir) / 'execution' / 'browser-shots' / run['id'] / f'{token_hex(8)}.png'
        return _once(browser, run, lambda: capture(browser, dest))
    raise ValidationError('Unknown browser tool')
