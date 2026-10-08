"""Actual DBOS journals must retain step invocation ordinals during recovery."""
import os
from pathlib import Path
import subprocess
import sys


def test_replay_after_committed_first_step(tmp_path):
    engine = Path(__file__).resolve().parents[1]
    script = '''
from pathlib import Path
import sys
import test_tool_chains as t
from homun.runtime.workflows import tool_chain as wf
from homun.runtime import dbos_app
from dbos import DBOS, SetWorkflowID

root = Path(sys.argv[1])
fixture = t.setup.__wrapped__(root)
ctx, actor, work, materials = next(fixture)
try:
    chain = t.propose(ctx, actor, work, {'command_id': 'ch',
        'steps': t.steps(materials[:2]), 'expected_version': 2})
    t.approve(ctx, actor, work, 'ch', {'command_id': 'ok',
        'digest': chain['digest'], 'expected_version': 2})
    wf.bind_context(ctx)
    dbos_app.configure_dbos(root)
    dbos_app.launch_dbos()
    original = wf._continue_if_more_steps
    def crash(*args):
        raise RuntimeError('crash after DBOS step commit')
    wf._continue_if_more_steps = crash
    with SetWorkflowID('repro-chain'):
        handle = DBOS.start_workflow(wf.tool_chain_workflow, chain['steps'])
    try:
        handle.get_result()
    except RuntimeError as exc:
        assert 'crash after DBOS step commit' in str(exc)
    else:
        raise AssertionError('Crash did not occur')
    assert len(ctx.repository.load().artifacts) == 1
    wf._continue_if_more_steps = original
    # Preserve the first durable step's result, then replay the workflow body.
    DBOS.fork_workflow('repro-chain', 2).get_result()
    store = ctx.repository.load()
    assert store.commands['ch'].result['status'] == 'completed'
    assert len(store.artifacts) == 2
    assert all(store.commands[s['proposal_id']].result['status'] == 'completed'
               for s in chain['steps'])
finally:
    dbos_app.shutdown_dbos()
    fixture.close()
'''
    env = {**os.environ, 'PYTHONPATH': os.pathsep.join([str(engine / 'src'), str(engine / 'tests')])}
    result = subprocess.run([sys.executable, '-c', script, str(tmp_path)],
                            env=env, capture_output=True, text=True, timeout=45)
    assert result.returncode == 0, result.stdout + result.stderr
