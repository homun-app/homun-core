from concurrent.futures import ThreadPoolExecutor
from threading import Event
from homun.application.write_approval_gate import WriteApprovalGate


def stage(gate):
    return gate.stage_action('workspace', 'write', {'text': 'x'}, summary='write')


def test_approval_without_executor_is_not_execution(tmp_path):
    gate = WriteApprovalGate(tmp_path)
    item = stage(gate)
    ok, result, error = gate.approve_and_execute(item.id)
    assert ok and not error
    assert result['status'] == 'approved_pending_execution'
    assert not WriteApprovalGate(tmp_path).get_record(item.id).executed
    calls = []
    assert gate.approve_and_execute(item.id, executor=lambda p: calls.append(p))[0]
    assert len(calls) == 1
    assert WriteApprovalGate(tmp_path).get_record(item.id).executed


def test_exception_after_effect_is_unknown_and_not_replayed(tmp_path):
    gate = WriteApprovalGate(tmp_path)
    item = stage(gate)
    calls = []
    def execute(payload):
        calls.append(payload)
        raise RuntimeError('lost receipt')
    assert not gate.approve_and_execute(item.id, executor=execute)[0]
    reopened = WriteApprovalGate(tmp_path)
    record = reopened.get_record(item.id)
    assert not record.executed
    assert record.execution_state == 'unknown'
    assert not reopened.approve_and_execute(item.id, executor=execute)[0]
    assert len(calls) == 1


def test_independent_gates_cannot_dispatch_twice(tmp_path):
    first, second = WriteApprovalGate(tmp_path), WriteApprovalGate(tmp_path)
    item = stage(first)
    entered, release = Event(), Event()
    calls = []
    def execute(payload):
        calls.append(payload)
        entered.set()
        assert release.wait(5)
    with ThreadPoolExecutor() as pool:
        pending = pool.submit(first.approve_and_execute, item.id, executor=execute)
        assert entered.wait(5)
        try:
            record = second.get_record(item.id)
            assert record is not None
            assert record.execution_state == 'dispatching'
            assert not second.approve_and_execute(item.id, executor=execute)[0]
            assert not second.reject_action(item.id)[0]
        finally:
            release.set()
        assert pending.result()[0]
    assert len(calls) == 1
