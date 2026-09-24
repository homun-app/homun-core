"""Run-authorized file observations and durable delivery of immutable snapshots."""
from copy import deepcopy
import hashlib
from homun.application import agent_native
from homun.application.agent_runs import authority,lookup
from homun.domain.errors import ConflictError,PermissionDeniedError
from homun.domain.models import CommandRecord,utc_now
from homun.execution.contracts import JobSpec,digest
from homun.execution.files import WorkspaceFiles,FileChangedError
from homun.execution.docker import DockerJobs
from homun.materials.managed_blobs import materials_lock,publish

OUTPUT_TYPE='work.output'


def root_for(ctx,run):
    spec=JobSpec(workspace_id=ctx.workspace_id,run_id=run['id'],call_id='files',image=run['terminal']['image'],command='true')
    return DockerJobs(ctx.data_dir.resolve()/'execution').workspace(spec)


def _authorized(ctx,store,actor,run):
    current=lookup(store,run['id'],run['work_id'])
    authority(ctx,store,actor,current,running=True)
    if (current.get('_workspace_files_version') not in {1,2} or current['status']!='running'
            or current['_epoch']!=run['_epoch'] or current.get('_lease_token')!=run.get('_lease_token')):
        raise ConflictError('Workspace operation no longer belongs to the active run')
    return current


def public(result):return deepcopy({k:v for k,v in result.items() if not k.startswith('_')})


def execute(ctx,actor,run,tool,args):
    store=ctx.repository.load();_authorized(ctx,store,actor,run)
    files=WorkspaceFiles(root_for(ctx,run))
    if tool in {'write_workspace_file','patch_workspace_file'}:
        raise ConflictError('File edits are applied only after exact approval')
    if tool=='deliver_workspace_file':return _deliver(ctx,actor,run,args,files)
    version=run.get('_workspace_files_version')
    if tool=='list_workspace_files':
        result=files.list_page(args.get('path',''),limit=args.get('limit',100),cursor=args.get('cursor','')) if version==2 else files.list(args.get('path',''),limit=args.get('limit',100))
    elif tool=='read_workspace_lines':
        from homun.execution.file_pages import page
        result=page(files,args['path'],offset=args.get('offset',1),limit=args.get('limit',200))
    elif tool=='search_workspace_files':
        from homun.execution.file_search import search
        result=search(files,args['pattern'],target=args.get('target','content'),path=args.get('path',''),
                      limit=args.get('limit',50),offset=args.get('offset',0))
    else:
        data=files.read(args['path'])
        result={'path':args['path'],'sha256':hashlib.sha256(data).hexdigest(),'byte_size':len(data)}
        try:
            text=data.decode('utf-8')
            if '\x00' in text:raise UnicodeError()
        except UnicodeError:
            result.update(binary=True,file_coverage={'path':args['path'],'sha256':result['sha256'],'complete':False,'representation':'binary'})
        else:
            offset=args.get('offset',0);limit=args.get('limit',6000)
            complete=offset==0 and offset+limit>=len(text)
            result.update(binary=False,text=text[offset:offset+limit],offset=offset,
                          next_offset=None if complete else offset+limit,
                          file_coverage={'path':args['path'],'sha256':result['sha256'],'complete':complete,
                                         'representation':'utf-8','total_lines':0 if complete and text=='' else None})
    _authorized(ctx,ctx.repository.load(),actor,run)
    return result


def _deliver(ctx,actor,run,args,files):
    call=agent_native.pending(run)
    if call is None:raise ConflictError('File delivery requires a canonical tool call')
    output_id='output:'+digest([run['id'],call.id])
    prior=ctx.repository.load().commands.get(output_id)
    if prior:
        if prior.type!=OUTPUT_TYPE or prior.result['_request']!=args:
            raise ConflictError('File delivery identity belongs to another snapshot')
        return public(prior.result)
    data=files.read(args['path']);sha=hashlib.sha256(data).hexdigest()
    if sha!=args['sha256']:raise FileChangedError('File changed since it was read; review the current file')
    with materials_lock(ctx.data_dir):
        with ctx.repository.locked():
            with ctx.repository.transaction() as store:
                _authorized(ctx,store,actor,run)
                prior=store.commands.get(output_id)
                if prior:
                    if prior.type!=OUTPUT_TYPE or prior.result['_request']!=args:
                        raise ConflictError('File delivery identity changed')
                    return public(prior.result)
                relpath,_=publish(ctx.data_dir,data,sha)
                result={'id':output_id,'work_id':run['work_id'],'run_id':run['id'],
                    'filename':args['path'].rsplit('/',1)[-1],'source_path':args['path'],
                    'sha256':sha,'byte_size':len(data),'created_at':utc_now().isoformat(),
                    'review_status':'unreviewed','_storage_relpath':relpath,'_request':deepcopy(args)}
                store.commands[output_id]=CommandRecord(command_id=output_id,type=OUTPUT_TYPE,
                    workspace_id=actor.workspace_id,actor_id=actor.id,result=result)
            ctx.service.store=store
    return public(result)
