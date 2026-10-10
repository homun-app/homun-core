"""Engine-backed runner for HostedMcpAgentServer (H35).

Starts real Homun work/agent-run proposals instead of inventing completion.
Without an EngineContext the runner refuses the call with a typed error.
"""
from __future__ import annotations

import logging
import hashlib
from copy import deepcopy
from typing import Any, Dict, List, Optional
from uuid import uuid4

from homun.domain.errors import ValidationError, BackendUnavailableError
from homun.domain.models import Actor

logger = logging.getLogger(__name__)


class HostedMcpEngineRunner:
    """Bridge MCP tool calls to Homun domain work and agent runs."""

    def __init__(self, *, default_actor_id: str = "person_mcp") -> None:
        self.default_actor_id = default_actor_id

    def _require_ctx(self, ctx: Any):
        if ctx is None:
            raise BackendUnavailableError(
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
        self, objective: str, files: Optional[List[str]] = None,
        allow_tools: Optional[List[str]] = None, *, ctx=None,
        actor: Optional[Actor] = None, command_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Persist a supervised proposal, with resumable idempotent admission."""
        engine = self._require_ctx(ctx)
        act = self._actor(engine, actor)
        from homun.application.agent_runs import propose
        from homun.application.price_comparisons import cached, save
        from homun.application.surface_toolset_policy import pin_policy
        from homun.policy.work import require_work_access
        from homun.policy import require_workspace_actor

        require_workspace_actor(act, engine.workspace_id)
        if not isinstance(objective, str) or not objective.strip():
            raise ValidationError("objective is required")
        if files:
            raise ValidationError("File import is unsupported here; attach canonical materials before proposing work")
        policy = pin_policy({"surface": "headless", "allowed_tools": allow_tools})
        if command_id is not None and (not isinstance(command_id, str) or not command_id.strip()):
            raise ValidationError("command_id must be a nonempty string")
        caller_id = command_id or uuid4().hex
        key = "hosted-task:" + hashlib.sha256(caller_id.encode()).hexdigest()
        payload = {"objective": objective, "files": [], "policy": policy}
        kind = "hosted_task.admit"
        # Save the admission before proposal construction. A crash between stages
        # resumes the same canonical work and exact proposal request on retry.
        with engine.repository.locked():
            with engine.repository.transaction() as store:
                record, fingerprint = cached(store, act, key, kind, payload)
                if record:
                    admission = deepcopy(record.result)
                    require_work_access(store, act, admission["work_id"], "write")
                else:
                    service = engine.service.for_store(store)
                    project = service.apply(act, key+":project", "project.create", {"name": "Hosted MCP"})
                    conv = service.apply(act, key+":conversation", "conversation.create", {"title": "Hosted MCP task", "project_id": project["project_id"]})
                    work = service.apply(act, key+":work", "work.create", {"conversation_id": conv["conversation_id"], "title": objective[:80], "objective": objective})
                    work_id = work["work_id"]
                    admission = {"work_id": work_id, "proposal_body": {
                        "command_id": key+":run", "expected_version": store.works[work_id].version,
                        "material_ids": [], **policy}}
                    save(store, act, key, kind, fingerprint, admission)
            if "result" in admission:
                return deepcopy(admission["result"])
            proposal = propose(engine, act, admission["work_id"], admission["proposal_body"])
            result = {
                "status": proposal["status"], "work_id": admission["work_id"],
                "run_id": proposal["id"], "digest": proposal.get("digest"),
                "expected_version": proposal.get("expected_version"),
                "objective": objective, "files": [], "allow_tools": allow_tools,
                "command_id": caller_id,
                "note": "Homun staged a real agent run. Approve it before execution.",
            }
            with engine.repository.transaction() as store:
                admission["result"] = result
                save(store, act, key, kind, fingerprint, admission)
            return deepcopy(result)

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
