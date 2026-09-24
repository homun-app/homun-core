"""Confined workspace search. Symlinks and non-regular files are skipped."""
from __future__ import annotations

import os
import re
import stat
from fnmatch import fnmatch

from homun.domain.errors import ValidationError
from homun.execution.files import MAX_BYTES, WorkspaceFiles

MAX_VISITS = 400
MAX_FILE_BYTES = 1024 * 1024
MAX_DEPTH = 12


def search(files: WorkspaceFiles, pattern: str, *, target: str = 'content', path: str = '',
           limit: int = 50, offset: int = 0) -> dict:
    if target not in {'content', 'filename'}:
        raise ValidationError('Search target must be content or filename')
    if not 1 <= limit <= 100 or not 0 <= offset <= 10000:
        raise ValidationError('Invalid search page')
    if not isinstance(pattern, str) or not 1 <= len(pattern) <= 200:
        raise ValidationError('Search pattern must be 1 to 200 characters')
    compiled = None
    if target == 'content':
        if pattern.count('+') + pattern.count('*') + pattern.count('{') > 12:
            raise ValidationError('Search pattern is too broad')
        try:
            compiled = re.compile(pattern)
        except re.error as exc:
            raise ValidationError(f'Invalid search pattern: {exc}') from None
    found, seen, visits, stopped = [], 0, 0, False

    def keep(item: dict):
        nonlocal seen, stopped
        seen += 1
        if offset < seen <= offset + limit:
            found.append(item)
        elif seen > offset + limit:
            stopped = True

    def walk(directory: str, depth: int):
        nonlocal visits, stopped
        if depth > MAX_DEPTH or stopped:
            return
        with files._open(directory, directory=True) as fd:
            names = sorted(os.listdir(fd))
        for name in names:
            if stopped:
                return
            if name.startswith('.homun-edit-'):
                continue
            rel = f'{directory}/{name}' if directory else name
            with files._open(directory, directory=True) as fd:
                info = os.stat(name, dir_fd=fd, follow_symlinks=False)
            if stat.S_ISLNK(info.st_mode):
                continue
            if stat.S_ISDIR(info.st_mode):
                if target == 'filename' and fnmatch(name, pattern):
                    keep({'path': rel, 'kind': 'directory'})
                walk(rel, depth + 1)
                continue
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                continue
            visits += 1
            if visits > MAX_VISITS:
                stopped = True
                return
            if target == 'filename':
                if fnmatch(name, pattern) or fnmatch(rel, pattern):
                    keep({'path': rel, 'kind': 'file', 'byte_size': info.st_size})
                continue
            if info.st_size > min(MAX_FILE_BYTES, MAX_BYTES):
                continue
            _content(files, rel, compiled, keep, lambda: stopped)

    walk(path, 0)
    return {'path': path, 'target': target, 'offset': offset, 'matches': found,
            'truncated': stopped, 'visits': min(visits, MAX_VISITS)}


def _content(files, path, pattern, keep, stop):
    try:
        data = files.read(path, max_bytes=MAX_FILE_BYTES)
    except ValidationError:
        return
    if b'\x00' in data[:8192]:
        return
    try:
        text = data.decode('utf-8')
    except UnicodeError:
        return
    for number, line in enumerate(text.split('\n'), 1):
        if stop():
            return
        if pattern.search(line):
            keep({'path': path, 'line': number, 'text': line[:200]})
