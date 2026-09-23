"""Owned runtime loop and orderly shutdown of background work."""
import asyncio
import logging
from contextlib import asynccontextmanager
from homun.runtime import dbos_app

@asynccontextmanager
async def runtime_lifespan(ctx):
    def start_runtime():
        dbos_app.configure_dbos(ctx.data_dir)
        from homun.runtime.workflows import work_run as _work_run_wf  # noqa: F401
        from homun.runtime.workflows import material_read, price_comparison, synthesis, tool_chain
        from homun.runtime.workflows import routine_recurrence as _routine_wf  # noqa: F401
        price_comparison.bind_context(ctx)
        material_read.bind_context(ctx)
        synthesis.bind_context(ctx)
        tool_chain.bind_context(ctx)
        dbos_app.launch_dbos()
        from homun.application.routines import reconcile_routine_schedules
        repaired = reconcile_routine_schedules(ctx)
        if repaired:
            logging.getLogger(__name__).info("Routine schedules repaired: %d", len(repaired))

    # DBOS must own its event loop so destroy cancels durable async waits before
    # closing its database. Adopting the ASGI loop prevents that cleanup.
    try:
        await asyncio.to_thread(start_runtime)
    except Exception:
        logging.getLogger(__name__).exception("Runtime startup failed")
        await asyncio.to_thread(dbos_app.shutdown_dbos)
        raise

    from homun.runtime.dispatcher import deliver_pending
    from homun.application.budgets import recover_pending
    recovered = recover_pending(ctx)
    if recovered:
        logging.getLogger(__name__).info("Budget recovery charged %d stale reservations as unknown", recovered)
    stop = asyncio.Event()

    from homun.application.routines import reconcile_routine_schedules, take_schedule_sync_request

    async def pump():
        while not stop.is_set():
            try:
                await asyncio.to_thread(deliver_pending, ctx)
            except Exception:
                logging.getLogger(__name__).exception("Runtime delivery pass failed")
            try:
                if take_schedule_sync_request():
                    await asyncio.to_thread(reconcile_routine_schedules, ctx)
            except Exception:
                logging.getLogger(__name__).exception("Routine schedule sync failed")
            try:
                await asyncio.wait_for(stop.wait(), timeout=0.5)
            except TimeoutError:
                pass

    from homun.application.followup_recovery import followup_recovery_lifespan
    worker = asyncio.create_task(pump())
    try:
        async with followup_recovery_lifespan(ctx):
            yield
    finally:
        stop.set()
        await worker
        await asyncio.to_thread(dbos_app.shutdown_dbos)
