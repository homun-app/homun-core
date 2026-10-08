"""Composition adapter for canonical run consent and human controls.

The engine context injects this adapter. Session tools depend on the operations
port on context rather than importing the run/tool orchestration back into itself.
"""
from homun.application import agent_runs, agent_control


class SessionOperations:
    def propose(self, ctx, actor, work_id, body):
        return agent_runs.propose(ctx, actor, work_id, body)

    def authorize(self, ctx, store, actor, work_id, run_id, *, running=False):
        return agent_runs.authority(ctx, store, actor, agent_runs.lookup(store, run_id, work_id), running=running)

    def control(self, ctx, store, actor, work_id, run_id, body):
        return agent_control.control_in_store(ctx, store, actor, work_id, run_id, body)
