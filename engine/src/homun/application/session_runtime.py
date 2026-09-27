"""Work-scoped canonical session operations shared by HTTP and registered tools."""
import json
from copy import deepcopy

from homun.application import session_history as history
from homun.application.price_comparisons import cached, save
from homun.domain.errors import BackendUnavailableError, ConflictError, DomainError, ValidationError
from homun.policy.work import require_work_access

SNAPSHOT_STATUS = {'fork': 'forked', 'rewind': 'rewound', 'import': 'imported', 'create': 'created'}

ACTIVE = {'pending_approval', 'queued', 'running', 'paused', 'waiting_input', 'waiting_external', 'waiting_automation'}


def get(ctx, actor, work_id, session_id):
    return history.lookup(ctx.repository.load(), actor, work_id, session_id)


def _command_id(args):
    value = args.get('command_id')
    if not isinstance(value, str) or not 1 <= len(value) <= 140:
        raise ValidationError('A command_id of 1 to 140 characters is required')
    return value


def _snapshot(ctx, actor, work_id, args):
    action = args['action']
    command_id = _command_id(args)
    if action == 'create' and any(args.get(key) is not None for key in ('cwd', 'model_pin', 'provider_pin', 'parent_id')):
        raise ValidationError('Create an empty session or use fork; runtime settings belong to a fresh proposal')
    if action == 'import':
        if args.get('db_path') is not None:
            raise ValidationError('Arbitrary database path is not allowed; bridge uses configured storage')
        if args.get('source_session_id'):
            from homun.application.session_import_bridge import bridge_import_snapshot
            from homun.application.session_manager import get_default_storage
            storage = args.get('source_storage') or get_default_storage()
            return bridge_import_snapshot(
                ctx, actor, work_id, storage, args['source_session_id'],
                command_id=command_id, title=args.get('title')
            )
        if not args.get('data'):
            raise ValidationError('Import requires data (JSONL) or source_session_id')
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            require_work_access(store, actor, work_id, 'write')
            source = history.lookup(store, actor, work_id, args['session_id']) if action in {'fork', 'rewind'} else None
            record, fingerprint = cached(store, actor, command_id, history.SNAPSHOT, {**args, 'work_id': work_id})
            if record:
                return {'status': SNAPSHOT_STATUS[action], 'session': history.lookup(store, actor, work_id, command_id)}
            if source:
                if action == 'rewind' and source['status'] in ACTIVE:
                    raise ConflictError('Cannot rewind an active run; its audit and physical effects remain unchanged')
                if args.get('expected_revision') and source['revision'] != args['expected_revision']:
                    raise ConflictError('Session revision changed')
                rows = history.closed_prefix(source['messages'], args.get('turn_index'))
                sources = [{'session_id': source['id'], 'work_id': work_id, 'count': len(rows), 'revision': history.revision(rows)}]
            elif action == 'import':
                rows = history.parse_import(args['data'], command_id)
                sources = []
            else:
                rows = []
                sources = []
            value = {'id': command_id, 'work_id': work_id, 'status': 'snapshot', 'operation': action,
                     'title': args.get('title'), 'parent_id': source['id'] if source else None,
                     'messages': rows, 'sources': sources, 'materials': deepcopy(source['materials']) if source else [],
                     'provenance': source['provenance'] if source else 'imported-untrusted'}
            if source and source.get('runtime_preferences'):
                value['runtime_preferences'] = deepcopy(source['runtime_preferences'])
            elif source and store.commands[source['id']].result.get('runtime_selection'):
                selected = store.commands[source['id']].result['runtime_selection']
                value['runtime_preferences'] = {key: selected[key] for key in ('connection_id', 'provider_id', 'model_id')}
            save(store, actor, command_id, history.SNAPSHOT, fingerprint, value)
            result = history.lookup(store, actor, work_id, command_id)
        ctx.service.store = store
    return {'status': SNAPSHOT_STATUS[action], 'session': result}


def _metadata(ctx, actor, work_id, args):
    command_id = _command_id(args)
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            require_work_access(store, actor, work_id, 'write')
            source = history.lookup(store, actor, work_id, args['session_id'])
            record, fingerprint = cached(store, actor, command_id, 'session.metadata', {**args, 'work_id': work_id})
            if not record:
                action = args['action']
                metadata = {key: args[key] for key in ('title', 'pinned', 'archived') if args.get(key) is not None}
                if action in {'pin', 'unpin'}:
                    metadata['pinned'] = action == 'pin'
                if action in {'archive', 'unarchive'}:
                    metadata['archived'] = action == 'archive'
                if metadata.get('archived') and source['status'] in ACTIVE:
                    raise ConflictError('Cannot archive an active canonical run')
                if args.get('model_pin') is not None or args.get('provider_pin') is not None:
                    from homun.application.session_runtime_preferences import update
                    metadata['runtime_preferences'] = update(ctx, store, source, args)
                if args.get('cwd') is not None:
                    raise ValidationError('Set runtime roots and model in a fresh continuation proposal')
                save(store, actor, command_id, 'session.metadata', fingerprint, {
                    'work_id': work_id, 'session_id': source['id'], 'metadata': metadata})
            result = history.lookup(store, actor, work_id, source['id'])
        ctx.service.store = store
    return {'status': 'updated', 'session': result}


def _list(ctx, actor, work_id, args):
    store = ctx.repository.load()
    require_work_access(store, actor, work_id, 'read')
    sessions = []
    for command in store.commands.values():
        if command.type not in {'agent_run.propose', history.SNAPSHOT} or command.result.get('work_id') != work_id:
            continue
        if command.type == 'agent_run.propose' and '_messages' not in command.result:
            continue
        try:
            view = history.lookup(store, actor, work_id, command.command_id)
        except DomainError:
            continue  # Unreadable histories are not search results, even by title or counts.
        if view['archived'] and not args.get('include_archived'):
            continue
        query = args.get('query')
        if query and str(query).casefold() not in json.dumps(view, ensure_ascii=False).casefold():
            continue
        sessions.append(view)
    return {'count': len(sessions), 'sessions': sessions}


def execute(ctx, actor, work_id, args, *, allow_run_control=True):
    action = str(args.get('action') or '').strip().lower()
    args = {**args, 'action': action}
    if action in {'get', 'fork', 'rewind', 'resume', 'update', 'pin', 'unpin', 'archive', 'unarchive', 'export', 'handoff'}:
        if action == 'handoff' and args.get('phase') == 'accept':
            pass
        elif not isinstance(args.get('session_id'), str) or not args['session_id'].strip():
            raise ValidationError('session_id is required for this action')
    if action == 'list':
        return _list(ctx, actor, work_id, args)
    if action in {'create', 'import', 'fork', 'rewind'}:
        return _snapshot(ctx, actor, work_id, args)
    if action in {'update', 'pin', 'unpin', 'archive', 'unarchive'}:
        return _metadata(ctx, actor, work_id, args)
    if action == 'resume':
        from homun.application.session_resume import prepare
        return prepare(ctx, actor, work_id, args, allow_run_control=allow_run_control)
    if action == 'handoff':
        from homun.application.session_profile_handoff import execute_handoff
        return execute_handoff(ctx, actor, work_id, args)
    if action in {'get', 'export'}:
        session = get(ctx, actor, work_id, args.get('session_id', ''))
        if action == 'get':
            return {'session': session, 'lineage': {'parent_id': session['parent_id'], 'sources': session.get('sources', [])}}
        fmt = args.get('format') or 'jsonl'
        if fmt == 'jsonl':
            header = {'type': 'session', 'version': 1, 'id': session['id'], 'revision': session['revision'], 'provenance': session['provenance']}
            data = '\n'.join(json.dumps(row, ensure_ascii=False) for row in [header, *session['messages']])
        elif fmt == 'markdown':
            data = '\n\n'.join(f"### {row['id']} · {row['message']['role']}\n\n```json\n{json.dumps(row['message'], ensure_ascii=False)}\n```" for row in session['messages'])
        else:
            raise ValidationError('Export format must be jsonl or markdown')
        if args.get('redact_secrets', True):
            from homun.application.session_manager import redact_secrets
            data = redact_secrets(data)
        return {'status': 'exported', 'session_id': session['id'], 'format': fmt, 'data': data,
                'revision': session['revision'], 'message_count': len(session['messages'])}
    if action == 'usage':
        from homun.application.session_usage import query
        return {'usage': query(ctx, actor, work_id, session_id=args.get('session_id'), limit=args.get('limit', 50), cursor=args.get('cursor'))}
    if action == 'search':
        from homun.application.session_search import search_canonical_sessions
        return search_canonical_sessions(ctx, actor, work_id, args.get('query', ''), limit=args.get('limit', 50), cursor=args.get('cursor'))
    if action == 'retention_preview':
        from homun.application.session_retention import preview_retention
        return preview_retention(ctx, actor, work_id, older_than_seconds=args.get('older_than_seconds'), include_pinned=args.get('include_pinned', False), session_id=args.get('session_id'))
    if action == 'prune':
        if args.get('preview', False):
            from homun.application.session_retention import preview_retention
            return preview_retention(ctx, actor, work_id, older_than_seconds=args.get('older_than_seconds'), include_pinned=args.get('include_pinned', False), session_id=args.get('session_id'))
        from homun.application.session_retention import apply_retention
        command_id = _command_id(args)
        return apply_retention(ctx, actor, work_id, command_id=command_id, selection_digest=args.get('selection_digest', ''), older_than_seconds=args.get('older_than_seconds'), include_pinned=args.get('include_pinned', False), session_id=args.get('session_id'))
    if action == 'check_integrity':
        from homun.application.session_integrity import check_integrity
        return check_integrity(ctx, actor, work_id)
    if action == 'repair':
        from homun.application.session_integrity import repair_sessions
        return repair_sessions(ctx, actor, work_id, preview=args.get('preview', True), command_id=args.get('command_id'))
    raise ValidationError(f'Unsupported canonical session action: {action!r}')
