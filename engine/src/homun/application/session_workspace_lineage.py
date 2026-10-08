"""Bounded authorized resolution of current files behind historical snapshots."""
from homun.application import session_records as records
from homun.application.session_dependencies import validate
from homun.domain.errors import ConflictError, ValidationError


def workspace_source(store, actor, work_id, session_id):
    roots = {}
    visited = set()

    def visit(work, ident, ancestors):
        key = (work, ident)
        if key in ancestors or len(ancestors) >= 64:
            raise ConflictError('Workspace lineage is cyclic or exceeds the depth limit')
        record = records.read(store, actor, work, ident)
        validate(store, actor, record.result)
        if key in visited:
            return
        visited.add(key)
        if len(visited) > 64:
            raise ConflictError('Workspace lineage exceeds the source limit')
        if record.type == 'agent_run.propose':
            roots[key] = record
            return
        sources = record.result.get('sources', [])
        if not sources:
            raise ValidationError('This history has no canonical workspace source')
        for source in sources:
            parent = records.read(store, actor, source['work_id'], source['session_id'])
            if records.revision(records.rows(parent)[:source['count']]) != source['revision']:
                raise ConflictError('Workspace lineage source revision changed')
            visit(source['work_id'], source['session_id'], ancestors | {key})

    visit(work_id, session_id, set())
    if len(roots) != 1:
        raise ValidationError('Workspace lineage has more than one canonical source')
    return next(iter(roots.values()))
