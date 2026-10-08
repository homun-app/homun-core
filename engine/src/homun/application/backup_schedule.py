"""Backup automatici periodici del workspace: la prevenzione dei dati.

Il backup consistente esisteva già (F2.5) ma nulla lo pianificava: dieci
giorni di buco lo hanno dimostrato. Questo è solo il timer — con retention,
perché un backup senza potatura riempe il disco e muore anch'esso.
"""
from __future__ import annotations

import asyncio
import logging
from pathlib import Path

logger = logging.getLogger(__name__)

DEFAULT_INTERVAL_SECONDS = 24 * 60 * 60
DEFAULT_RETENTION = 7


async def run_backup_loop(ctx, *, interval_seconds: float = DEFAULT_INTERVAL_SECONDS,
                          retention: int = DEFAULT_RETENTION) -> None:
    """Ciclo asyncio: backup consistente ogni interval, potando i più vecchi."""
    while True:
        await asyncio.sleep(interval_seconds)
        try:
            await asyncio.to_thread(_backup_once, ctx, retention)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Backup automatico fallito: si riprova al prossimo ciclo")


def _backup_once(ctx, retention: int) -> str | None:
    from homun.storage.backup import create_backup
    backups_root = ctx.repository.path.parent / "backups"
    with ctx.repository.locked() as connection:
        backup_dir = create_backup(
            workspace_id=ctx.workspace_id,
            source_db=ctx.repository.path,
            backups_root=backups_root,
            live_connection=connection,
        )
    _prune(backups_root, retention)
    logger.info("Backup automatico completato: %s", backup_dir.name)
    return str(backup_dir)


def _prune(backups_root: Path, retention: int) -> None:
    if retention <= 0 or not backups_root.is_dir():
        return
    import shutil
    entries = sorted(path for path in backups_root.iterdir() if path.is_dir())
    for stale in entries[:-retention] if len(entries) > retention else []:
        shutil.rmtree(stale, ignore_errors=True)
        logger.info("Backup automatico potato (retention %d): %s", retention, stale.name)


def start_backup_scheduler(ctx, *, interval_seconds: float = DEFAULT_INTERVAL_SECONDS,
                           retention: int = DEFAULT_RETENTION) -> asyncio.Task:
    return asyncio.create_task(
        run_backup_loop(ctx, interval_seconds=interval_seconds, retention=retention),
        name="homun-backup-scheduler",
    )

async def run_wal_checkpoint_loop(ctx, *, interval_seconds: float = 300) -> None:
    """Checkpoint PASSIVE periodico del WAL del workspace.

    Con synchronous=FULL ogni commit è durabile nel WAL, quindi il crash di
    un processo non perde dati; il punto debole resta un checkpoint interrotto
    da kill -9 con un WAL lungo. Piegare il WAL nel main ogni pochi minuti
    riduce quella finestra quasi a zero, a costo di una richiesta PASSIVE
    che non blocca i writer."""
    import asyncio
    import logging
    logger = logging.getLogger(__name__)
    while True:
        await asyncio.sleep(interval_seconds)
        try:
            def _checkpoint() -> int:
                with ctx.repository.locked() as conn:
                    return conn.execute("PRAGMA wal_checkpoint(PASSIVE)").fetchone()[0]
            await asyncio.to_thread(_checkpoint)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.warning("checkpoint WAL periodico fallito", exc_info=True)


def start_wal_checkpoint_scheduler(ctx, *, interval_seconds: float = 300) -> asyncio.Task:
    return asyncio.create_task(
        run_wal_checkpoint_loop(ctx, interval_seconds=interval_seconds),
        name="homun-wal-checkpoint")
