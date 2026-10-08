"""Frozen provenance for transcript data returned by model-invoked session tools.

References pin physical repository prefixes, not recursively expanding mutable
run histories. Self reads add no edge; inherited references are flattened so
later appends cannot create a graph cycle or change an already read prefix.
"""
from copy import deepcopy
from homun.application import session_records as records
from homun.application.agent_run_policy import history_is_readable
from homun.domain.errors import ConflictError, NotFoundError, PermissionDeniedError
from homun.policy.work import require_work_access


def validate(store, actor, run, *, ctx=None):
    for dep in run.get('_session_dependencies', []):
        require_work_access(store, actor, dep['work_id'], 'read')
        record = store.commands.get(dep['session_id'])
        if not record or record.type not in {'agent_run.propose', records.SNAPSHOT} or record.result.get('work_id') != dep['work_id']:
            raise NotFoundError('Session tool source no longer exists')
        if not history_is_readable(store, actor, {'materials': dep['materials']}):
            raise PermissionDeniedError('Session tool source material is no longer readable')
        if records.revision(records.rows(record)[:dep['count']]) != dep['revision']:
            raise ConflictError('Session tool source prefix changed')
        if ctx is not None:
            from homun.application.agent_tools import validate_sources
            validate_sources(ctx, store, actor, dep['materials'])


def _collect(store, actor, source_id, work_id, consumer_id, *, count=None, expected_revision=None, seen=None):
    if source_id == consumer_id:
        return []
    seen = set(seen or ())
    if source_id in seen:
        raise ConflictError('Session source lineage is cyclic')
    seen.add(source_id)
    record = records.authorize_record(store, actor, work_id, source_id)
    validate(store, actor, record.result)
    rows = records.rows(record)
    if count is not None:
        rows = rows[:count]
    if expected_revision is not None and records.revision(rows) != expected_revision:
        raise ConflictError('Session tool source prefix changed after reading')
    dependencies = [{'session_id': source_id, 'work_id': work_id, 'count': len(rows),
                     'revision': records.revision(rows), 'materials': deepcopy(record.result['materials'])}]
    value = record.result
    dependencies.extend(deepcopy(value.get('_session_dependencies', [])))
    parents = list(value.get('sources', []))
    if value.get('_session_context'):
        parents.append(value['_session_context'])
    for parent in parents:
        dependencies.extend(_collect(store, actor, parent['session_id'], parent['work_id'], consumer_id,
                                     count=parent['count'], expected_revision=parent['revision'], seen=seen))
    return [item for item in dependencies if item['session_id'] != consumer_id]


def retain(ctx, actor, run, args, result):
    """Persist source authority before the caller admits a tool result to history."""
    reads = {}
    views = list(result.get('sessions', []))
    if isinstance(result.get('session'), dict):
        views.append(result['session'])
    for source in views:
        reads[source['id']] = (len(source['messages']), source['revision'])
    if args.get('session_id') and args.get('action') == 'export':
        reads[args['session_id']] = (result['message_count'], result['revision'])
    usage_deps = result.get('usage', {}).get('read_bindings', [])
    if not reads and not usage_deps:
        return
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            require_work_access(store, actor, run['work_id'], 'read')
            record = store.commands.get(run['id'])
            if not record or record.type != 'agent_run.propose' or record.result['work_id'] != run['work_id']:
                raise NotFoundError('Canonical consumer run not found')
            current = record.result
            deps = deepcopy(current.get('_session_dependencies', []))
            for source_id, (count, digest) in sorted(reads.items()):
                for dep in _collect(store, actor, source_id, run['work_id'], run['id'], count=count, expected_revision=digest):
                    if dep not in deps:
                        deps.append(dep)
            for dep in usage_deps:
                if dep['session_id'] != run['id'] and dep not in deps:
                    deps.append(deepcopy(dep))
            current['_session_dependencies'] = deps
            validate(store, actor, current, ctx=ctx)
        ctx.service.store = store


def material_bindings(store, actor, work_id, session_id):
    """Pin every material revision whose content can be inherited by continuation."""
    bindings = []
    for dependency in _collect(store, actor, session_id, work_id, None):
        for binding in dependency['materials']:
            if binding not in bindings:
                bindings.append(deepcopy(binding))
    return bindings
