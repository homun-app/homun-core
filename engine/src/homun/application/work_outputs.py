"""Authorized listing/download of immutable, run-originated file snapshots."""
import hashlib
from homun.application.workspace_files import OUTPUT_TYPE,public
from homun.domain.errors import ConflictError,NotFoundError
from homun.execution.files import MAX_BYTES
from homun.materials.blob import read_material_blob
from homun.policy.work import require_work_access


def list_for_work(ctx,actor,work_id):
    store=ctx.repository.load();require_work_access(store,actor,work_id,'read')
    return {'items':[public(r.result) for r in store.commands.values()
                     if r.type==OUTPUT_TYPE and r.result['work_id']==work_id]}


def download(ctx,actor,work_id,output_id):
    store=ctx.repository.load();require_work_access(store,actor,work_id,'read')
    record=store.commands.get(output_id)
    if record is None or record.type!=OUTPUT_TYPE or record.result['work_id']!=work_id:
        raise NotFoundError('Work output not found')
    metadata=record.result
    try:data=read_material_blob(ctx.data_dir,metadata['_storage_relpath'],max_bytes=MAX_BYTES)
    except (OSError,ValueError):raise ConflictError('Work output content is unavailable') from None
    if len(data)!=metadata['byte_size'] or hashlib.sha256(data).hexdigest()!=metadata['sha256']:
        raise ConflictError('Work output failed integrity verification')
    require_work_access(ctx.repository.load(),actor,work_id,'read')
    return public(metadata),data
