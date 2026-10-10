"""Lossless run-scoped output storage with bounded model-facing projections.

Tool result storage and scoped output paging.
"""
import hashlib
import json
from pydantic import Field
from homun.application.agent_tools import NoArguments
from homun.domain.errors import ConflictError, ValidationError
from homun.models.agent_turn import ToolDefinition
from homun.tools.registry import ToolEntry

INLINE_CHARACTERS = 20000
PREVIEW_CHARACTERS = 1600


class ReadResultArguments(NoArguments):
    result_ref: str = Field(min_length=1,max_length=100)
    offset: int = Field(default=0,ge=0)
    limit: int = Field(default=1000,ge=1,le=1000)
    query: str | None = Field(default=None,min_length=1,max_length=200)


def _flags(result):
    if not isinstance(result,dict):
        return {}
    flags={}
    for key in ('is_error','isError','error_code','status','ok','success','truncated'):
        value=result.get(key)
        if key in result and (value is None or isinstance(value,(bool,int,float)) or isinstance(value,str) and len(value)<=80):
            flags[key]=value
    if result.get('error'):
        flags['has_error_detail']=True
    return flags


def project(run,tool_name,call_id,result):
    if run.get('_result_storage_version')!=1:
        return result
    raw=json.dumps(result,ensure_ascii=False,sort_keys=True,separators=(',',':'))
    if len(raw)<=INLINE_CHARACTERS:
        return result
    digest=hashlib.sha256(raw.encode()).hexdigest()
    ref='result_'+digest
    run.setdefault('_tool_results',{}).setdefault(ref,{'text':raw,'tool':tool_name,'call_id':call_id})
    head=int(PREVIEW_CHARACTERS*0.4);tail=PREVIEW_CHARACTERS-head
    projected={'result_ref':ref,'format':'json','sha256':digest,'total_characters':len(raw),
        'preview':raw[:head]+f'\n[OMITTED {len(raw)-PREVIEW_CHARACTERS} CHARACTERS]\n'+raw[-tail:],
        'notice':'Full result saved. Use read_tool_result with this result_ref to page or search literal text. Preview is incomplete.',
        **_flags(result)}
    coverage=result.get('file_coverage') if isinstance(result,dict) else None
    if isinstance(coverage,dict) and len(json.dumps(coverage,sort_keys=True))<=500:
        projected['file_coverage']=coverage
    return projected


def read(run,arguments):
    args=ReadResultArguments.model_validate(arguments)
    stored=run.get('_tool_results',{}).get(args.result_ref)
    if stored is None:
        raise ValidationError('Saved result is not available in this run')
    raw=stored['text']
    digest=hashlib.sha256(raw.encode()).hexdigest()
    if args.result_ref!='result_'+digest:
        raise ConflictError('Saved tool result integrity check failed')
    result={'result_ref':args.result_ref,'format':'json','total_characters':len(raw),
            'sha256':digest,**_flags(json.loads(raw))}
    start=min(args.offset,len(raw))
    if args.query is not None:
        found=raw.find(args.query,start)
        result.update(found=found>=0,match_offset=found if found>=0 else None)
        if found<0:
            return {**result,'offset':start,'text':'','next_offset':None}
        start=max(start,found-200)
    end=min(len(raw),start+args.limit)
    return {**result,'offset':start,'text':raw[start:end], 'next_offset':end if end<len(raw) else None}


def entry():
    return ToolEntry(ToolDefinition(name='read_tool_result',
        description='Read a page of a full saved tool result by its result_ref. Offsets count characters in the saved JSON. Optional query locates exact case-sensitive text at or after offset. Read further pages using next_offset. Original tool error flags remain visible.',
        input_schema=ReadResultArguments.model_json_schema()),'results','1',ReadResultArguments,
        lambda ctx,actor,run,args:read(run,args))
