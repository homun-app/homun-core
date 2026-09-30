"""Owned runtime loop and orderly shutdown of background work."""
import asyncio
import logging
from contextlib import asynccontextmanager
from homun.runtime import dbos_app
from homun.application.cron_dispatcher import fire_due_jobs
from homun.application.cron_reconciliation import reconcile_cron_runs
from homun.application.agent_automation import wake_due_automation

@asynccontextmanager
async def runtime_lifespan(ctx):
    def start_runtime():
        dbos_app.configure_dbos(ctx.data_dir)
        from homun.runtime.workflows import work_run as _work_run_wf  # noqa: F401
        from homun.runtime.workflows import material_read, price_comparison, synthesis, tool_chain, agent_run
        from homun.runtime.workflows import routine_recurrence as _routine_wf  # noqa: F401
        price_comparison.bind_context(ctx)
        material_read.bind_context(ctx)
        synthesis.bind_context(ctx)
        tool_chain.bind_context(ctx)
        agent_run.bind_context(ctx)
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
    try:
        import os
        catalog_dir = os.environ.get("HOMUN_SKILL_CATALOG_DIR")
        if catalog_dir:
            from homun.application.skill_catalog_sync import sync_skill_catalog
            sync_skill_catalog(ctx, catalog_dir)
        else:
            from homun.application.skill_seeding import seed_builtin_skills
            seed_builtin_skills(ctx)
    except Exception:
        logging.getLogger(__name__).exception("Skill catalog bootstrap failed")
    if recovered:
        logging.getLogger(__name__).info("Budget recovery charged %d stale reservations as unknown", recovered)
    stop = asyncio.Event()

    from homun.application.routines import reconcile_routine_schedules, take_schedule_sync_request

    cron_worker = None

    async def pump():
        nonlocal cron_worker
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
                await asyncio.to_thread(reconcile_cron_runs, ctx, limit=20)
                if cron_worker is None or cron_worker.done():
                    if cron_worker is not None:
                        finished, cron_worker = cron_worker, None
                        finished.result()
                    cron_worker = asyncio.create_task(asyncio.to_thread(
                        fire_due_jobs, ctx.workspace_id, ctx=ctx, limit=1, cancelled=stop.is_set))
            except Exception:
                logging.getLogger(__name__).exception("Cron due-fire pass failed")
            try:
                from homun.application import cron_deliveries as _cron_delivery_pass
                await asyncio.to_thread(_cron_delivery_pass.deliver_pending, ctx)
            except Exception:
                logging.getLogger(__name__).exception("Cron delivery pass failed")
            try:
                from homun.application.skill_curator import maybe_curate
                await asyncio.to_thread(maybe_curate, ctx)
            except Exception:
                logging.getLogger(__name__).exception("Skill curation pass failed")
            try:
                from homun.application.approval_relay import notify_pending
                await asyncio.to_thread(notify_pending, ctx)
            except Exception:
                logging.getLogger(__name__).exception("Approval relay notify pass failed")
            try:
                from homun.application.delegation_runtime import reconcile_delegations
                await asyncio.to_thread(reconcile_delegations, ctx, limit=20)
                await asyncio.to_thread(wake_due_automation, ctx, limit=20)
            except Exception:
                logging.getLogger(__name__).exception("Automation wake pass failed")
            try:
                await asyncio.wait_for(stop.wait(), timeout=0.5)
            except TimeoutError:
                pass

    async def channel_poller_loop():
        from homun.application.whatsapp_bridge_process import ensure_whatsapp_bridge
        from homun.routes.channel_ingress_api import poll_enabled_channels
        while not stop.is_set():
            try:
                await asyncio.to_thread(poll_enabled_channels, timeout=2)
            except Exception:
                pass
            try:
                await asyncio.to_thread(ensure_whatsapp_bridge)
            except Exception:
                pass
            try:
                await asyncio.wait_for(stop.wait(), timeout=1.0)
            except TimeoutError:
                pass

    from homun.application.followup_recovery import followup_recovery_lifespan
    worker = asyncio.create_task(pump())
    poller_worker = asyncio.create_task(channel_poller_loop())
    try:
        async with followup_recovery_lifespan(ctx):
            yield
    finally:
        stop.set()
        await worker
        await poller_worker
        try:
            from homun.application.whatsapp_bridge_process import stop_whatsapp_bridge
            await asyncio.to_thread(stop_whatsapp_bridge)
        finally:
            try:
                if cron_worker is not None:
                    await cron_worker
            finally:
                await asyncio.to_thread(dbos_app.shutdown_dbos)
