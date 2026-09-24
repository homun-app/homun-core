"""Pure, version-pinned contracts for workspace observation and file delivery."""
from pydantic import BaseModel,ConfigDict,Field
from homun.models.agent_turn import ToolDefinition
from homun.tools.registry import ToolEntry


class ListFiles(BaseModel):
    model_config=ConfigDict(extra='forbid',strict=True)
    path: str=Field(default='',max_length=1024)
    limit: int=Field(default=100,ge=1,le=200)


class ReadFile(BaseModel):
    model_config=ConfigDict(extra='forbid',strict=True)
    path: str=Field(min_length=1,max_length=1024)
    offset: int=Field(default=0,ge=0,le=25*1024*1024)
    limit: int=Field(default=6000,ge=1,le=8000)


class DeliverFile(BaseModel):
    model_config=ConfigDict(extra='forbid',strict=True)
    path: str=Field(min_length=1,max_length=1024)
    sha256: str=Field(pattern=r'^[0-9a-f]{64}$')


CONTRACTS={
    'list_workspace_files':(ListFiles,'List files/directories in this run workspace, using relative paths. A truncated list is incomplete.'),
    'read_workspace_file':(ReadFile,'Read a UTF-8 page and SHA256 of a workspace file (max 25 MiB). Binary files return metadata/hash without text. Offsets count characters.'),
    'deliver_workspace_file':(DeliverFile,'Save an immutable downloadable copy for the person reviewing this work. First read the file to obtain its exact SHA256. This does not approve the final work or send anything externally.'),
}


def entries(handler=None):
    for name,(schema,description) in CONTRACTS.items():
        def execute(ctx,actor,run,args,tool=name):return handler(ctx,actor,run,tool,args)
        yield ToolEntry(ToolDefinition(name=name,description=description,input_schema=schema.model_json_schema()),
                        'workspace_files','1',schema,execute if handler else None,
                        replay='never' if name=='deliver_workspace_file' else 'read_only')
