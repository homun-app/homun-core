"""Engine-backed runner for HostedMcpAgentServer (H35).

Starts real Homun work/agent-run proposals instead of inventing completion.
Without an EngineContext the runner refuses the call with a typed error.
"""
from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional
from uuid import uuid4

from homun.domain.errors import ValidationError
from homun.domain.models import Actor

logger = logging.getLogger(__name__)


class HostedMcpEngineRunner:
    """Bridge MCP tool calls to Homun domain work and agent runs."""

    def __init__(self, *, default_actor_id: str = "person_mcp") -> None:
        self.default_actor_id = default_actor_id

    def _require_ctx(self, ctx: Any):
        if ctx is None:
            raise ValidationError(
                "Hosted MCP runner requires an EngineContext. "
                "Pass ctx when calling tools, or configure the server with a bound context."
            )
        return ctx

    def _actor(self, ctx, actor: Optional[Actor] = None) -> Actor:
        if actor is not None:
            return actor
        return Actor(
            id=self.default_actor_id,
            workspace_id=ctx.workspace_id,
            display_name="Homun MCP",
        )

    def ask(self, question: str, context: str = "", *, ctx=None, actor: Optional[Actor] = None) -> str:
        """Answer without tools via the active model connection (no invented text)."""
        engine = self._require_ctx(ctx)
        from homun.models.native_turn import NativeMessage

        connections = engine.models.list_connections()
        connection = next((c for c in connections if c.active), None)
        if connection is None and connections:
            connection = connections[0]
        if connection is None:
            raise ValidationError("No model connection for hosted MCP ask")

        prompt = question
        if context.strip():
            prompt = f"Context:\n{context.strip()}\n\nQuestion: {question}"
        messages = [
            NativeMessage(role="system", content="Answer briefly. Do not claim tools were used."),
            NativeMessage(role="user", content=prompt),
        ]
        result = engine.models.complete_summary(messages, connection_id=connection.id)
        return (result.message.content if result.message else "") or ""

    def run_task(
        self,
        objective: str,
        files: Optional[List[str]] = None,
        allow_tools: Optional[List[str]] = None,
        *,
        ctx=None,
        actor: Optional[Actor] = None,
    ) -> Dict[str, Any]:
        """Create supervised work and propose a native agent run (pending approval)."""
        engine = self._require_ctx(ctx)
        act = self._actor(engine, actor)
        from homun.application.agent_runs import propose

        cmd = uuid4().hex[:10]
        project = engine.service.apply(
            act,
            f"mcp-p-{cmd}",
            "project.create",
            {"name": "Hosted MCP"},
        )
        project_id = project["project_id"] if isinstance(project, dict) else project
        conv = engine.service.apply(
            act,
            f"mcp-c-{cmd}",
            "conversation.create",
            {"title": "Hosted MCP task", "project_id": project_id},
        )
        conversation_id = conv["conversation_id"] if isinstance(conv, dict) else conv
        work = engine.service.apply(
            act,
            f"mcp-w-{cmd}",
            "work.create",
            {
                "conversation_id": conversation_id,
                "title": (objective[:80] or "MCP task"),
                "objective": objective,
            },
        )
        work_id = work["work_id"] if isinstance(work, dict) else work
        engine.persist()

        store = engine.repository.load()
        work_obj = store.works[work_id]
        body = {
            "command_id": f"mcp-run-{cmd}",
            "expected_version": work_obj.version,
            "material_ids": [],
        }
        proposal = propose(engine, act, work_id, body)
        engine.persist()
        return {
            "status": "pending_approval",
            "work_id": work_id,
            "run_id": proposal.get("id"),
            "digest": proposal.get("digest"),
            "expected_version": proposal.get("expected_version"),
            "objective": objective,
            "files": list(files or []),
            "allow_tools": list(allow_tools or []),
            "note": "Homun staged a real agent run. Approve it before execution.",
        }

    def get_status(self, work_id: str, *, ctx=None, actor: Optional[Actor] = None) -> Dict[str, Any]:
        engine = self._require_ctx(ctx)
        act = self._actor(engine, actor)
        from homun.application.agent_runs import list_runs

        store = engine.repository.load()
        if work_id not in store.works:
            raise ValidationError(f"Work '{work_id}' not found")
        work = store.works[work_id]
        runs = list_runs(engine, act, work_id)
        return {
            "work_id": work_id,
            "status": work.status,
            "objective": work.objective,
            "runs": runs.get("items") if isinstance(runs, dict) else runs,
        }
