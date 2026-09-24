"""Pure, version-pinned contracts for workspace observation and file delivery."""
from pydantic import BaseModel, ConfigDict, Field
from homun.models.agent_turn import ToolDefinition
from homun.tools.registry import ToolEntry


class ListFiles(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    path: str = Field(default='', max_length=1024)
    limit: int = Field(default=100, ge=1, le=200)


class ListFilesPage(ListFiles):
    cursor: str = Field(default='', max_length=255)


class ReadFile(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    path: str = Field(min_length=1, max_length=1024)
    offset: int = Field(default=0, ge=0, le=25 * 1024 * 1024)
    limit: int = Field(default=6000, ge=1, le=8000)


class ReadLines(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    path: str = Field(min_length=1, max_length=1024)
    offset: int = Field(default=1, ge=1, le=25 * 1024 * 1024)
    limit: int = Field(default=200, ge=1, le=400)


class SearchFiles(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    pattern: str = Field(min_length=1, max_length=200)
    target: str = Field(default='content', pattern=r'^(content|filename)$')
    path: str = Field(default='', max_length=1024)
    offset: int = Field(default=0, ge=0, le=10000)
    limit: int = Field(default=50, ge=1, le=100)


class WriteFile(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    path: str = Field(min_length=1, max_length=1024)
    content: str = Field(max_length=200000)
    baseline_sha256: str | None = Field(default=None, pattern=r'^[0-9a-f]{64}$')


class PatchFile(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    path: str = Field(min_length=1, max_length=1024)
    old_string: str = Field(min_length=1, max_length=80000)
    new_string: str = Field(max_length=80000)
    replace_all: bool = False
    baseline_sha256: str = Field(pattern=r'^[0-9a-f]{64}$')


class DeliverFile(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    path: str = Field(min_length=1, max_length=1024)
    sha256: str = Field(pattern=r'^[0-9a-f]{64}$')


def _catalog(version):
    listing = (
        'List files and directories in this run workspace, using relative paths. '
        'Pass next_cursor to continue a truncated page. scan_limited means the directory is too large to enumerate completely.')
    yield 'list_workspace_files', (ListFilesPage if version == 2 else ListFiles), listing if version == 2 else (
        'List files/directories in this run workspace, using relative paths. A truncated list is incomplete.')
    yield 'read_workspace_file', ReadFile, (
        'Read a UTF-8 character page and SHA256 of a workspace file (max 25 MiB). '
        'Binary files return metadata/hash without text. Offsets count characters.')
    if version == 2:
        yield 'read_workspace_lines', ReadLines, (
            'Read a 1-based line page and SHA256 of a workspace file. Pages are limited to 6000 characters. '
            'Use next_line to continue. PDF and DOCX return extracted text when available; other binaries return metadata only. '
            'A full current read is required before write_workspace_file.')
        yield 'search_workspace_files', SearchFiles, (
            'Search this run workspace. target=content uses a Python regular expression on UTF-8 text. '
            'target=filename uses a glob on names. Symlinks are skipped. A truncated result is incomplete.')
        yield 'write_workspace_file', WriteFile, (
            'Propose a full UTF-8 replacement. For an existing file, baseline_sha256 must be the SHA256 from a complete current read. '
            'Omit it only when creating a new file. The file is not changed until the person approves this exact proposal.')
        yield 'patch_workspace_file', PatchFile, (
            'Propose a targeted replacement of old_string with new_string. baseline_sha256 must match the current file. '
            'The match can tolerate whitespace and indentation drift; ambiguous matches are refused. '
            'The file is not changed until the person approves this exact proposal.')
    yield 'deliver_workspace_file', DeliverFile, (
        'Save an immutable downloadable copy for the person reviewing this work. First read the file to obtain its exact SHA256. '
        'This does not approve the final work or send anything externally.')


def entries(handler=None, version=1):
    for name, schema, description in _catalog(version):
        def execute(ctx, actor, run, args, tool=name):
            return handler(ctx, actor, run, tool, args)
        yield ToolEntry(
            ToolDefinition(name=name, description=description, input_schema=schema.model_json_schema()),
            'workspace_files', str(version), schema, execute if handler else None,
            replay='never' if name in {'deliver_workspace_file', 'write_workspace_file', 'patch_workspace_file'} else 'read_only')
