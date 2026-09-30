"""Batch/evals: esecuzione concorrente, checkpoint/ripresa, aggregazione tool, API."""
import json

import pytest
from fastapi.testclient import TestClient

from homun.app import create_app
from homun.application.batch_eval_runner import BatchEvalRunner, BatchItem


def fake_executor(results=None, fail_ids=(), raise_ids=()):
    """Esecutore deterministico: niente modelli, niente risultati inventati."""
    results = results or {}

    def _execute(item: BatchItem):
        if item.id in raise_ids:
            raise RuntimeError('backend esploso')
        return results.get(item.id) or __import__('homun.application.batch_eval_runner',
                                                   fromlist=['BatchItemResult']).BatchItemResult(
            id=item.id,
            success=item.id not in fail_ids,
            output=f'out:{item.prompt}',
            latency_seconds=0.01,
            error='atteso fallimento' if item.id in fail_ids else None,
            tool_stats={'terminal_execute': {'count': 1, 'success': 1, 'failure': 0}},
        )
    return _execute


def test_run_batch_aggregates_results_and_tool_stats(tmp_path):
    runner = BatchEvalRunner(tmp_path, task_executor=fake_executor(fail_ids={'b'}))
    results, summary = runner.run_batch(
        [BatchItem(id='a', prompt='p1'), BatchItem(id='b', prompt='p2')],
        run_name='run_agg')
    assert {r.id for r in results} == {'a', 'b'}
    assert summary.total_items == 2 and summary.completed_items == 1 and summary.failed_items == 1
    # le statistiche tool di entrambi gli item finiscono nello stesso aggregato
    assert summary.aggregated_tool_stats['terminal_execute']['count'] == 2


def test_run_batch_records_executor_exceptions_as_failures(tmp_path):
    runner = BatchEvalRunner(tmp_path, task_executor=fake_executor(raise_ids={'x'}))
    results, summary = runner.run_batch([BatchItem(id='x', prompt='boom')], run_name='run_exc')
    assert results[0].success is False
    assert 'backend esploso' in (results[0].error or '')
    assert summary.failed_items == 1


def test_resume_skips_checkpoints_and_keeps_previous_results(tmp_path):
    # primo giro: un solo item, completato e salvato nel checkpoint
    first = BatchEvalRunner(tmp_path, task_executor=fake_executor())
    results1, summary1 = first.run_batch([BatchItem(id='done', prompt='p')], run_name='run_res')
    assert summary1.completed_items == 1
    checkpoint = tmp_path / 'run_res_checkpoint.jsonl'
    assert checkpoint.exists()

    # secondo giro con resume: l'item già fatto non viene rieseguito
    calls = []

    def counting(item: BatchItem):
        calls.append(item.id)
        return fake_executor()(item)

    second = BatchEvalRunner(tmp_path, task_executor=counting)
    results2, summary2 = second.run_batch(
        [BatchItem(id='done', prompt='p'), BatchItem(id='todo', prompt='q')],
        run_name='run_res', resume=True)
    assert calls == ['todo']
    assert {r.id for r in results2} == {'done', 'todo'}
    assert summary2.completed_items == 2


def test_runner_without_executor_refuses_to_invent_results(tmp_path):
    runner = BatchEvalRunner(tmp_path, task_executor=None)
    with pytest.raises(ValueError, match='will not invent'):
        runner.run_batch([BatchItem(id='a', prompt='p')], run_name='run_noexec')


def test_http_batch_run_endpoint(monkeypatch, tmp_path):
    from homun.app import create_app as _create_app
    from homun.context import create_context, reset_context_for_tests
    reset_context_for_tests(
        create_context(workspace_id='ws_local', db_path=tmp_path / 'ws_local.sqlite3',
                       data_dir=tmp_path, for_tests=True))
    app = _create_app()
    client = TestClient(app)
    from homun.routes import research_api
    monkeypatch.setattr(research_api, '_batch_runner',
                        BatchEvalRunner(tmp_path, task_executor=fake_executor(fail_ids={'bad'})))
    response = client.post('/v1/research/batch/run', json={
        'items': [{'id': 'ok', 'prompt': 'p'}, {'id': 'bad', 'prompt': 'q'}],
        'run_name': 'api_run'})
    assert response.status_code == 200
    body = response.json()
    assert body['summary']['total_items'] == 2
    assert body['summary']['failed_items'] == 1
    assert {r['id'] for r in body['results']} == {'ok', 'bad'}

    # backend assente: 503 tipizzato, mai risultati inventati
    monkeypatch.setattr(research_api, '_batch_runner', BatchEvalRunner(tmp_path, task_executor=None))
    missing = client.post('/v1/research/batch/run',
                          json={'items': [{'id': 'ok', 'prompt': 'p'}]})
    assert missing.status_code == 503
