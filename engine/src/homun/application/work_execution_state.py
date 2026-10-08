"""Shared admission check for executions persisted in either runtime store."""
EXECUTION_COMMAND_TYPES = frozenset({
    'agent_run.propose', 'synthesis.propose', 'material_read.propose',
    'price_comparison.propose', 'tool_chain.propose',
})

def has_active_execution(store, work_id):
    return (any(run.work_id == work_id and run.status in {'queued','running'} for run in store.runs.values())
            or any(record.type in EXECUTION_COMMAND_TYPES
                   and record.result.get('work_id') == work_id
                   and record.result.get('status') in {'queued','running'}
                   for record in store.commands.values()))
