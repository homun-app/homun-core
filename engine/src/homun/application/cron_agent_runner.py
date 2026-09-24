"""Run due cron prompt/skills jobs by staging real Homun agent-run proposals (H28/H29).

Script jobs continue to use subprocess. Prompt jobs without an EngineContext remain
backend_unavailable (see CronManager); this runner is the product-owned executor.
"""
from __future__ import annotations

import logging
from typing import Any, Dict, Optional, Tuple
from uuid import uuid4

from homun.domain.errors import ValidationError
from homun.domain.models import Actor

logger = logging.getLogger(__name__)


class CronAgentRunner:
    """Stage a pending_approval agent run for a cron prompt payload."""

    def __init__(self, *, default_actor_id: str = "person_cron") -> None:
        self.default_actor_id = default_actor_id

    def __call__(self, payload: Dict[str, Any]) -> Tuple[int, str, Optional[str]]:
        ctx = payload.get("ctx")
        if ctx is None:
            return (
                -1,
                "Cron agent runner requires EngineContext in payload['ctx']",
                "backend_unavailable",
            )
        prompt = str(payload.get("prompt") or "").strip()
        if not prompt:
            return -1, "Cron job prompt is empty", "validation_error"

        actor = payload.get("actor")
        if actor is None:
            actor = Actor(
                id=self.default_actor_id,
                workspace_id=ctx.workspace_id,
                display_name="Homun Cron",
            )

        from homun.application.agent_runs import propose

        cmd = uuid4().hex[:10]
        try:
            project = ctx.service.apply(
                actor,
                f"cron-p-{cmd}",
                "project.create",
                {"name": "Cron jobs"},
            )
            project_id = project["project_id"] if isinstance(project, dict) else project
            conv = ctx.service.apply(
                actor,
                f"cron-c-{cmd}",
                "conversation.create",
                {"title": f"Cron {payload.get('job_id') or cmd}", "project_id": project_id},
            )
            conversation_id = conv["conversation_id"] if isinstance(conv, dict) else conv
            work = ctx.service.apply(
                actor,
                f"cron-w-{cmd}",
                "work.create",
                {
                    "conversation_id": conversation_id,
                    "title": (prompt[:80] or "Cron task"),
                    "objective": prompt,
                },
            )
            work_id = work["work_id"] if isinstance(work, dict) else work
            ctx.persist()
            store = ctx.repository.load()
            work_obj = store.works[work_id]
            body = {
                "command_id": f"cron-run-{cmd}",
                "expected_version": work_obj.version,
                "material_ids": [],
            }
            if payload.get("model_pin"):
                body["model"] = payload["model_pin"]
            proposal = propose(ctx, actor, work_id, body)
            ctx.persist()
            summary = (
                f"Staged agent run {proposal.get('id')} for work {work_id} "
                f"(status=pending_approval digest={proposal.get('digest')})"
            )
            return 0, summary, None
        except (ValidationError, Exception) as exc:
            logger.warning("Cron agent runner failed: %s", exc)
            return -1, str(exc), "execution_failed"


def make_cron_runner(ctx, actor: Optional[Actor] = None) -> CronAgentRunner:
    """Bind ctx/actor into a callable suitable for CronManager.run_job(custom_runner=...)."""
    base = CronAgentRunner()

    def _bound(payload: Dict[str, Any]) -> Tuple[int, str, Optional[str]]:
        enriched = dict(payload)
        enriched["ctx"] = ctx
        if actor is not None:
            enriched["actor"] = actor
        return base(enriched)

    return _bound  # type: ignore[return-value]
