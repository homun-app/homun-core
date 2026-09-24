"""Dispatch one owned browser read and remove its private profile."""
import shutil
from pathlib import Path
from secrets import token_hex

from homun.domain.errors import ValidationError
from homun.execution.owned_browser import read_page


def execute(ctx, actor, run, tool, args):
    if run.get('browser', {}).get('policy') != 'owned-headless-v1':
        raise ValidationError('The browser is not enabled for this run')
    if tool != 'browser_read':
        raise ValidationError('Unknown browser tool')
    root = Path(ctx.data_dir) / 'execution' / 'browsers' / token_hex(8)
    try:
        return read_page(root, args['url'])
    finally:
        shutil.rmtree(root, ignore_errors=True)
