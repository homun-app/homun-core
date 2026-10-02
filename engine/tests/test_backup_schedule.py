"""Backup automatici: il timer con retention che chiude il buco dei 10 giorni."""
from __future__ import annotations

import asyncio

import pytest

from homun.application.backup_schedule import _backup_once, _prune, run_backup_loop
from homun.context import create_context


@pytest.fixture
def ctx(tmp_path):
    ctx = create_context(db_path=tmp_path / 'engine.db', data_dir=tmp_path, for_tests=True)
    yield ctx
    ctx.close()


def test_backup_once_creates_consistent_backup(ctx):
    result = _backup_once(ctx, retention=7)
    assert result is not None
    from pathlib import Path
    backup_dir = Path(result)
    assert (backup_dir / 'manifest.json').is_file()
    assert (backup_dir / f'{ctx.workspace_id}.sqlite3').is_file()


def test_prune_keeps_only_recent(ctx, tmp_path):
    _backup_once(ctx, retention=7)
    for extra in range(10):
        (tmp_path / 'backups' / f'2020010{extra}T000000Z').mkdir(parents=True)
    _prune(tmp_path / 'backups', 7)
    remaining = sorted(path.name for path in (tmp_path / 'backups').iterdir())
    assert len(remaining) == 7
    # il backup reale sopravvive sempre, i più vecchi cadono
    assert any(name.startswith('2026') for name in remaining)
    assert '20200100T000000Z' not in remaining
    assert '20200103T000000Z' not in remaining


def test_loop_runs_and_cancels(ctx):
    async def scenario():
        task = asyncio.create_task(run_backup_loop(ctx, interval_seconds=0.05, retention=7))
        await asyncio.sleep(0.4)
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass

    asyncio.run(scenario())
    backups = list((ctx.repository.path.parent / 'backups').iterdir())
    assert len(backups) >= 1
    assert len(backups) <= 7
