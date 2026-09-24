"""Approved workspace edits: one exact proposal, one write, durable recovery."""
from copy import deepcopy
import difflib
import hashlib
from homun.application import agent_native
from homun.application.agent_runs import authority, lookup
from homun.application.workspace_checkpoints import note_agent_write, snapshot_before_write
from homun.application.workspace_file_baseline import full_baseline, seen_current
from homun.application.workspace_files import root_for
from homun.domain.errors import ConflictError, NotFoundError, PermissionDeniedError, ValidationError
from homun.domain.models import CommandRecord, utc_now
from homun.execution.contracts import digest
from homun.execution.file_match import already_applied, replace
from homun.execution.file_syntax import delta
from homun.execution.files import WorkspaceFiles
from homun.materials.blob import read_material_blob
from homun.materials.managed_blobs import materials_lock, publish
from homun.policy.work import require_work_access

TYPE = 'workspace.file_edit'
BLOCKED_SUFFIXES = {
    '.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.zip', '.gz', '.docx', '.xlsx',
    '.pptx', '.sqlite', '.db', '.wasm', '.so', '.dylib', '.exe', '.mp3', '.mp4', '.ico', '.bin',
}
MUTATIONS = {'write_workspace_file', 'patch_workspace_file'}


class StaleFileError(ValidationError):
    code = 'workspace_file_stale'


def _suffix(path):
    return '.' + path.rsplit('.', 1)[-1].lower() if '.' in path else ''


def _display_dump(content):
    lines = [line for line in content.splitlines() if line.strip()]
    if len(lines) < 2:
        return False
    numbers = []
    for line in lines:
        prefix, sep, _rest = line.lstrip().partition('|')
        if sep and prefix.isdigit():
            numbers.append(int(prefix))
    if len(numbers) < 2 or len(numbers) / len(lines) < 0.6:
        return False
    pairs = sum(1 for previous, current in zip(numbers, numbers[1:]) if current == previous + 1)
    return pairs >= len(numbers) - 1


def _text(files, path):
    try:
        data = files.read(path)
    except ValidationError as exc:
        if exc.message == 'Workspace file is unavailable':
            return None
        raise
    try:
        text = data.decode('utf-8')
        if '\x00' in text:
            raise UnicodeError()
    except UnicodeError:
        raise ValidationError('Text edits cannot change a binary workspace file') from None
    return data, text


def _normalize(text):
    ending = '\r\n' if '\r\n' in text else '\n'
    bom = text.startswith('\ufeff')
    body = text[1:] if bom else text
    return body.replace('\r\n', '\n').replace('\r', '\n'), ending, bom


def _restore(text, ending, bom):
    if ending != '\n':
        text = text.replace('\n', ending)
    return ('\ufeff' if bom else '') + text


def _preview(path, before, after):
    diff = ''.join(difflib.unified_diff(
        before.splitlines(True), after.splitlines(True), fromfile=path, tofile=path, n=2))
    if len(diff) > 4000:
        return diff[:4000] + '\n... diff truncated; approval still covers the exact byte hash.'
    return diff or '(no textual difference)'


def plan(run, files, tool, args):
    """Compute the exact bytes to approve. Does not write."""
    path = args['path']
    if _suffix(path) in BLOCKED_SUFFIXES:
        raise ValidationError(f'{_suffix(path)} cannot be rewritten as text. The file was not modified.')
    loaded = _text(files, path)
    strategy = None
    if tool == 'write_workspace_file':
        content = args['content']
        if _display_dump(content):
            raise ValidationError('Refusing to write numbered read-tool display text. The file was not modified.')
        if '\x00' in content:
            raise ValidationError('Workspace text cannot contain NUL')
        if loaded is None:
            if args.get('baseline_sha256'):
                raise StaleFileError('A new file has no baseline hash. Omit baseline_sha256. The file was not created.')
            before, before_sha, previous = '', None, None
        else:
            data, text = loaded
            before_sha = hashlib.sha256(data).hexdigest()
            if args.get('baseline_sha256') != before_sha or not full_baseline(run, path, before_sha):
                raise StaleFileError(
                    'Refusing to overwrite a file that was not fully read at its current SHA256. '
                    'Read every page with read_workspace_lines, or read the whole file, then write again. The file was not modified.')
            before, previous = text, text
        after = content
    else:
        if loaded is None:
            raise ValidationError('Cannot patch a file that does not exist. The file was not modified.')
        data, text = loaded
        before_sha = hashlib.sha256(data).hexdigest()
        if args['baseline_sha256'] != before_sha or not seen_current(run, path, before_sha):
            raise StaleFileError(
                'Refusing to patch from a stale or unread snapshot. Read the current file and retry. The file was not modified.')
        normalized, ending, bom = _normalize(text)
        if already_applied(normalized, args['old_string'], args['new_string']):
            return {'already': True, 'path': path, 'sha256': before_sha,
                    'message': 'The replacement is already present. No write was performed.'}
        updated, _count, strategy, error = replace(
            normalized, args['old_string'], args['new_string'], replace_all=bool(args.get('replace_all', False)))
        if error:
            raise ValidationError(error + ' The file was not modified.')
        before, after, previous = text, _restore(updated, ending, bom), text
    encoded = after.encode('utf-8')
    diagnostics = delta(path, previous, after)
    if diagnostics.get('blocked'):
        raise ValidationError(diagnostics['reason'])
    return {'path': path, 'operation': 'write' if tool == 'write_workspace_file' else 'patch',
            'before_sha256': before_sha, 'after': encoded, 'after_sha256': hashlib.sha256(encoded).hexdigest(),
            'diff_preview': _preview(path, before, after), 'diagnostics': diagnostics, 'strategy': strategy}


def _binding(run):
    call = agent_native.pending(run)
    return {'run_id': run['id'], 'epoch': run['_epoch'], 'call_id': call.id,
            'lease_token': run['_lease_token'], 'tool': call.name, 'arguments': deepcopy(call.arguments)}


def _consent(result):
    bound = {key: result[key] for key in (
        'id', 'work_id', 'path', 'operation', 'before_sha256', 'after_sha256', 'expected_version')}
    bound['_agent_binding'] = result['_agent_binding']
    return digest(bound)


def public(result):
    shown = {key: deepcopy(result.get(key)) for key in (
        'id', 'work_id', 'path', 'operation', 'status', 'digest', 'before_sha256', 'after_sha256',
        'diff_preview', 'diagnostics', 'strategy', 'byte_size', 'error_code', 'error', 'agent_run_id')}
    return {key: value for key, value in shown.items() if value is not None}


def stage(ctx, actor, run, decision):
    files = WorkspaceFiles(root_for(ctx, run))
    planned = plan(run, files, decision.tool, decision.arguments)
    if planned.get('already'):
        return {'path': planned['path'], 'sha256': planned['sha256'], 'applied': False,
                'already_present': True, 'message': planned['message'],
                'file_coverage': {'path': planned['path'], 'sha256': planned['sha256'],
                                  'complete': True, 'representation': 'utf-8'}}
    call = agent_native.pending(run)
    proposal_id = 'file-edit:' + digest([run['id'], run['_epoch'], call.id])
    with materials_lock(ctx.data_dir):
        relpath, _created = publish(ctx.data_dir, planned['after'], planned['after_sha256'])
        with ctx.repository.locked():
            with ctx.repository.transaction() as store:
                current = lookup(store, run['id'], run['work_id'])
                authority(ctx, store, actor, current, running=True)
                if (current.get('_workspace_files_version') != 2 or current['_epoch'] != run['_epoch']
                        or current.get('_lease_token') != run.get('_lease_token')):
                    raise ConflictError('File edit no longer belongs to the active run')
                work = require_work_access(store, actor, run['work_id'])
                result = {'id': proposal_id, 'work_id': run['work_id'], 'path': planned['path'],
                          'operation': planned['operation'], 'before_sha256': planned['before_sha256'],
                          'after_sha256': planned['after_sha256'], 'diff_preview': planned['diff_preview'],
                          'diagnostics': planned['diagnostics'], 'strategy': planned['strategy'],
                          'byte_size': len(planned['after']), 'expected_version': work.version,
                          'status': 'pending_approval', 'agent_run_id': run['id'],
                          '_storage_relpath': relpath, '_agent_binding': _binding(current),
                          '_request': deepcopy(decision.arguments)}
                result['digest'] = _consent(result)
                prior = store.commands.get(proposal_id)
                if prior:
                    if prior.type != TYPE or prior.result.get('digest') != result['digest']:
                        raise ConflictError('File edit identity belongs to another proposal')
                    return 'waiting_external'
                current.update(status='waiting_external', file_edit_request_id=proposal_id)
                for key in ('_lease_token', '_lease_until', '_active_call_id'):
                    current.pop(key, None)
                store.commands[proposal_id] = CommandRecord(
                    command_id=proposal_id, type=TYPE, actor_id=actor.id,
                    workspace_id=actor.workspace_id, result=result)
            ctx.service.store = store
    return 'waiting_external'


def _lookup(store, actor, work_id, proposal_id, *, write=False):
    require_work_access(store, actor, work_id, 'write' if write else 'read')
    record = store.commands.get(proposal_id)
    if record is None or record.type != TYPE or record.result['work_id'] != work_id:
        raise NotFoundError('File edit proposal not found for this work')
    return record.result


def _owner(actor, store, work_id):
    work = require_work_access(store, actor, work_id, 'write')
    if actor.kind != 'person' or actor.id not in {work.owner_id, work.reviewer_id}:
        raise PermissionDeniedError('Only the owner or reviewer may approve a file edit')
    return work


def _linked(ctx, store, actor, proposal):
    link = proposal['_agent_binding']
    run = lookup(store, link['run_id'], proposal['work_id'])
    authority(ctx, store, actor, run, running=True)
    if run['status'] != 'waiting_external' or run.get('file_edit_request_id') != proposal['id'] or run['_epoch'] != link['epoch']:
        raise ConflictError('File edit was cancelled or superseded')
    call = agent_native.pending(run)
    if call is None or call.id != link['call_id'] or call.name != link['tool'] or call.arguments != link['arguments']:
        raise ConflictError('File edit differs from the canonical call')
    return run


def list_for_work(ctx, actor, work_id):
    store = ctx.repository.load()
    require_work_access(store, actor, work_id, 'read')
    items = [public(record.result) for record in store.commands.values()
             if record.type == TYPE and record.result['work_id'] == work_id]
    return {'items': items}


def approve(ctx, actor, work_id, proposal_id, body):
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            proposal = _lookup(store, actor, work_id, proposal_id, write=True)
            work = _owner(actor, store, work_id)
            if body.get('digest') != proposal['digest'] or _consent(proposal) != proposal['digest']:
                raise ValidationError('Approval does not match the proposed file edit')
            if proposal['status'] != 'pending_approval':
                return public(proposal)
            if work.archived or work.version != proposal['expected_version']:
                raise ConflictError('Work changed or is archived; create a new file edit')
            _linked(ctx, store, actor, proposal)
            proposal.update(status='applying', _approved_by=actor.id, _approved_at=utc_now().isoformat())
            snapshot = deepcopy(proposal)
        ctx.service.store = store
    return _apply(ctx, actor, work_id, proposal_id, snapshot)


def _apply(ctx, actor, work_id, proposal_id, snapshot):
    data = read_material_blob(ctx.data_dir, snapshot['_storage_relpath'], max_bytes=25 * 1024 * 1024)
    if hashlib.sha256(data).hexdigest() != snapshot['after_sha256']:
        return _finish(ctx, actor, work_id, proposal_id, snapshot, 'outcome_unknown',
                       'Approved bytes failed integrity verification. The file was not written again.')
    run = ctx.repository.load().commands[snapshot['_agent_binding']['run_id']].result
    root = root_for(ctx, run)
    snapshot_before_write(root, reason=f"pre-write:{snapshot['path']}")
    outcome = WorkspaceFiles(root).write_bytes(
        snapshot['path'], data, before_sha=snapshot['before_sha256'])
    if outcome in {'written', 'already'}:
        note_agent_write(root, snapshot['path'])
        return _finish(ctx, actor, work_id, proposal_id, snapshot, 'applied', None)
    if outcome == 'mismatch':
        return _finish(ctx, actor, work_id, proposal_id, snapshot, 'conflict',
                       'The file changed after approval. It was not modified again. Read the current file.')
    return _finish(ctx, actor, work_id, proposal_id, snapshot, 'outcome_unknown',
                   'The write could not be verified. Do not send it again; read the file hash first.')


def _finish(ctx, actor, work_id, proposal_id, snapshot, status, error):
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            proposal = _lookup(store, actor, work_id, proposal_id, write=True)
            if proposal.get('_approved_at') != snapshot.get('_approved_at') or proposal['digest'] != snapshot['digest']:
                raise ConflictError('File edit changed during writing')
            if proposal['status'] in {'applied', 'conflict', 'outcome_unknown'}:
                return public(proposal)
            proposal['status'] = status
            if error:
                proposal.update(error=error, error_code='workspace_file_uncertain' if status == 'outcome_unknown' else 'workspace_file_changed')
            elif status == 'applied':
                proposal.pop('error', None)
                proposal.pop('error_code', None)
        ctx.service.store = store
    require_work_access(ctx.repository.load(), actor, work_id, 'read')
    return public(proposal)


def resume(ctx, run_id):
    store = ctx.repository.load()
    run = lookup(store, run_id)
    if run['status'] != 'waiting_external' or not run.get('file_edit_request_id'):
        return False
    from homun.domain.models import Actor
    actor = Actor.model_validate(run['_actor'])
    authority(ctx, store, actor, run, running=True)
    proposal_id = run['file_edit_request_id']
    proposal = store.commands[proposal_id].result
    if proposal['status'] == 'pending_approval':
        return False
    if proposal['status'] == 'applying':
        _apply(ctx, actor, run['work_id'], proposal_id, deepcopy(proposal))
        proposal = ctx.repository.load().commands[proposal_id].result
        if proposal['status'] == 'applying':
            return False
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            run = lookup(store, run_id)
            if run['status'] != 'waiting_external' or run.get('file_edit_request_id') != proposal_id:
                return False
            proposal = store.commands[proposal_id].result
            if proposal['status'] not in {'applied', 'conflict', 'outcome_unknown'}:
                return False
            call = agent_native.pending(run)
            receipt = public(proposal)
            receipt.update(applied=proposal['status'] == 'applied', is_error=proposal['status'] != 'applied',
                           sha256=proposal['after_sha256'] if proposal['status'] == 'applied' else proposal.get('before_sha256'))
            if proposal['status'] == 'applied':
                receipt['file_coverage'] = {'path': proposal['path'], 'sha256': proposal['after_sha256'],
                                             'complete': True, 'representation': 'utf-8'}
            receipt = agent_native.append_result(run, receipt)
            run['observations'].append({'tool': call.name, 'arguments': call.arguments,
                                        'message': 'Workspace file edit completed', 'result': receipt})
            run['turns'] += 1
            for key in ('_decision', '_active_call_id', 'file_edit_request_id'):
                run.pop(key, None)
            run['_epoch'] += 1
            run.update(status='queued', _workflow_id=f'agent:{actor.workspace_id}:{run_id}:{run["_epoch"]}')
        ctx.service.store = store
    return True
