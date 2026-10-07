"""Consumer for queued cron deliveries: channels and conversations (H28/H29).

Cron occurrences with a non-local deliver target enqueue a durable delivery
row at settle time; this module drains it. Targets:
- ``chat``            → the job's source work conversation, as an engine message
- ``<platform>:<id>`` → the channel adapter (telegram:123456, whatsapp:3933…)
Failures are typed and journaled on the row — never silently dropped.
"""
from __future__ import annotations

import logging
import uuid
from typing import Any, Dict

from homun.domain.models import utc_now

logger = logging.getLogger(__name__)

MAX_ATTEMPTS = 3
OUTPUT_CHAR_LIMIT = 3500


def deliver_pending(ctx, *, store=None, limit: int = 10) -> Dict[str, Any]:
    """Dispatch pending deliveries once; safe to call from the pump loop."""
    from homun.application.cron_manager import CronManager
    manager = CronManager(workspace_id=ctx.workspace_id, store=store) if store is not None \
        else CronManager(workspace_id=ctx.workspace_id)
    sent, failed, deferred = [], [], []
    for delivery_id, payload in manager._store.pending_deliveries(ctx.workspace_id)[:limit]:
        attempts = int(payload.get("attempts") or 0)
        outcome = _deliver_one(ctx, payload)
        payload["attempts"] = attempts + 1
        payload["last_attempt_at"] = utc_now().isoformat()
        payload["status"] = outcome["status"]
        payload["error_code"] = outcome.get("error_code")
        if outcome["status"] == "sent":
            payload["receipt"] = outcome.get("receipt")
            sent.append({"delivery_id": delivery_id, "target": payload.get("target")})
        elif outcome["status"] == "pending" and payload["attempts"] < MAX_ATTEMPTS:
            deferred.append({"delivery_id": delivery_id, "target": payload.get("target"),
                             "error_code": outcome.get("error_code")})
        else:
            payload["status"] = "failed"
            failed.append({"delivery_id": delivery_id, "target": payload.get("target"),
                           "error_code": outcome.get("error_code")})
        manager._store.update_delivery(ctx.workspace_id, delivery_id, payload)
    return {"sent": sent, "failed": failed, "deferred": deferred,
            "processed": len(sent) + len(failed) + len(deferred)}


def _deliver_one(ctx, payload: Dict[str, Any]) -> Dict[str, Any]:
    target = str(payload.get("target") or "").strip()
    output = str(payload.get("output") or "").strip()[:OUTPUT_CHAR_LIMIT]
    if not output:
        return {"status": "failed", "error_code": "delivery_empty_output"}
    if target in ("chat", "conversation"):
        return _deliver_to_conversation(ctx, payload, output)
    if ":" in target:
        platform, _, chat_id = target.rpartition(":")
        platform = platform.strip().lower()
        chat_id = chat_id.strip()
        if not platform or not chat_id:
            return {"status": "failed", "error_code": "delivery_target_invalid"}
        return _deliver_to_channel(platform, chat_id, output)
    return {"status": "failed", "error_code": "delivery_target_invalid"}


def _deliver_to_conversation(ctx, payload: Dict[str, Any], output: str) -> Dict[str, Any]:
    from homun.domain.commands.conversations import append_engine_message
    from homun.domain.models import Actor
    from homun.application.cron_manager import CronManager
    store = ctx.repository.snapshot()
    manager = CronManager(workspace_id=ctx.workspace_id)
    job = manager.get_job(str(payload.get("job_id") or ""))
    source_work = getattr(job, "source_work_id", None) if job is not None else None
    work = store.works.get(str(source_work)) if source_work else None
    conversation_id = work.primary_conversation_id if work is not None else None
    if not conversation_id:
        return {"status": "failed", "error_code": "delivery_conversation_unavailable"}
    actor = Actor(id="person_local", workspace_id=ctx.workspace_id, display_name="Cron delivery")
    try:
        with ctx.repository.locked():
            with ctx.repository.transaction() as transaction_store:
                service = ctx.service.for_store(transaction_store)
                append_engine_message(
                    service._context,
                    actor=actor,
                    command_id=f"cron-delivery:{payload.get('occurrence_id') or uuid.uuid4().hex[:8]}",
                    conversation_id=conversation_id,
                    author_id="engine_cron",
                    text=output,
                    event_type="message.created",
                    event_payload={"cron_job_id": payload.get("job_id")},
                )
            ctx.service.store = transaction_store
    except Exception as exc:  # conversation appends are local: failure is permanent
        logger.warning("Cron chat delivery failed: %s", exc)
        return {"status": "failed", "error_code": "delivery_conversation_failed"}
    return {"status": "sent", "receipt": {"conversation_id": conversation_id}}


def _deliver_to_channel(platform: str, chat_id: str, output: str) -> Dict[str, Any]:
    try:
        from homun.application.channel_delivery_recovery import send_with_media_dispatch
        from homun.routes.channel_ingress_api import get_channel_registry
        registry = get_channel_registry()
        adapter = registry.get_adapter(platform)
    except Exception as exc:
        logger.warning("Cron channel delivery bootstrap failed: %s", exc)
        return {"status": "pending", "error_code": "delivery_registry_unavailable"}
    if adapter is None:
        return {"status": "failed", "error_code": "channel_unsupported"}
    if not getattr(adapter, "config", None):
        return {"status": "pending", "error_code": "channel_unconfigured"}
    try:
        receipt = send_with_media_dispatch(adapter, chat_id, output)
    except Exception as exc:
        logger.warning("Cron channel delivery to %s failed: %s", platform, exc)
        return {"status": "pending", "error_code": "delivery_transport_failed"}
    if not receipt.get("delivered"):
        # Mai riportare successo senza consegna reale: resta pendente, ritentabile.
        code = receipt.get("code") or "delivery_transport_failed"
        logger.warning("Cron channel delivery to %s not delivered (%s): %s",
                       platform, code, receipt.get("error"))
        return {"status": "pending", "error_code": "delivery_transport_failed"}
    return {"status": "sent", "receipt": receipt}
