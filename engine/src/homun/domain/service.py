"""Command facade; feature implementations live in domain.commands."""

from __future__ import annotations
from collections.abc import Callable, Iterable
from copy import deepcopy
from homun.domain.command_identity import request_fingerprint
from typing import Any
from pathlib import Path
from homun.domain.errors import ConflictError, ValidationError
from homun.domain.models import AccessGrant, Actor, AgentProfile, CommandRecord, Conversation, MaterialVersion, PlanRevision, Project, Run, Team, Work
from homun.domain.store import WorkspaceStore
from homun.policy import require_workspace_actor, require_project_capability

from homun.policy.commands import require_command_authority
from homun.policy.intake import require_intake_command_admission
from homun.domain.command_context import CommandContext
from homun.domain.commands.agents import _agent_create
from homun.domain.commands.agents import _agent_rename
from homun.domain.commands.agents import _agent_update
from homun.domain.commands.teams import _team_create
from homun.domain.commands.teams import _team_update
from homun.domain.commands.teams import _team_archive
from homun.domain.commands.conversations import _conversation_create
from homun.domain.commands.conversations import _conversation_post_message
from homun.domain.commands.projects import _project_create
from homun.domain.commands.projects import _project_create_from_conversation
from homun.domain.commands.projects import _project_update
from homun.domain.commands.projects import _project_archive
from homun.domain.commands.grants import _grant_issue
from homun.domain.commands.grants import _grant_revoke
from homun.domain.commands.materials import _material_create
from homun.domain.commands.materials import _material_update
from homun.domain.commands.materials import _material_archive
from homun.domain.commands.work import _work_create
from homun.domain.commands.work import _work_link_conversation
from homun.domain.commands.plans import _plan_propose
from homun.domain.commands.plans import _plan_accept
from homun.domain.commands.plans import _plan_revise
from homun.domain.commands.patches import _work_preview_patch
from homun.domain.commands.patches import _work_apply_patch
from homun.domain.commands.execution import _work_start
from homun.domain.commands.execution import _work_request_contribution
from homun.domain.commands.execution import _work_provide_contribution
from homun.domain.commands.reviews import _work_submit_artifact
from homun.domain.commands.reviews import _work_review
from homun.domain.commands.work import _work_pause
from homun.domain.commands.work import _work_cancel
from homun.domain.commands.conversations import append_engine_message
from homun.domain.commands.projects import ensure_project_for_work
from homun.domain.commands.materials import register_prepared_material

from homun.domain.commands.naming import work_rename, conversation_rename
from homun.domain.commands.budgets import work_set_budget

HANDLERS = {
    "work.rename": work_rename,
    "work.set_budget": work_set_budget,
    "conversation.rename": conversation_rename,
    "agent.create": _agent_create,
    "agent.rename": _agent_rename,
    "agent.update": _agent_update,
    "team.create": _team_create,
    "team.update": _team_update,
    "team.archive": _team_archive,
    "conversation.create": _conversation_create,
    "conversation.post_message": _conversation_post_message,
    "project.create": _project_create,
    "project.create_from_conversation": _project_create_from_conversation,
    "project.update": _project_update,
    "project.archive": _project_archive,
    "grant.issue": _grant_issue,
    "grant.revoke": _grant_revoke,
    "material.create": _material_create,
    "material.update": _material_update,
    "material.archive": _material_archive,
    "work.create": _work_create,
    "work.link_conversation": _work_link_conversation,
    "plan.propose": _plan_propose,
    "plan.accept": _plan_accept,
    "plan.revise": _plan_revise,
    "work.preview_patch": _work_preview_patch,
    "work.apply_patch": _work_apply_patch,
    "work.start": _work_start,
    "work.request_contribution": _work_request_contribution,
    "work.provide_contribution": _work_provide_contribution,
    "work.submit_artifact": _work_submit_artifact,
    "work.review": _work_review,
    "work.pause": _work_pause,
    "work.cancel": _work_cancel,
}


class DomainService:
    """Compatibility facade: command admission and feature dispatch only."""

    def __init__(self, store: WorkspaceStore, *,
                 known_connection_ids: Callable[[], Iterable[str]] | None = None,
                 durable_runtime: bool = False, data_dir: Path | None = None) -> None:
        self._context = CommandContext(store, known_connection_ids=known_connection_ids,
                                       durable_runtime=durable_runtime, data_dir=data_dir)

    def for_store(self, store: WorkspaceStore) -> DomainService:
        """Bind the same dependencies to a disposable request snapshot."""
        return DomainService(store,
                             known_connection_ids=self._context._known_connection_ids,
                             durable_runtime=self._context._durable_runtime,
                             data_dir=self._context._data_dir)

    @property
    def store(self) -> WorkspaceStore:
        return self._context.store

    @store.setter
    def store(self, store: WorkspaceStore) -> None:
        self._context.store = store

    def apply(self, actor: Actor, command_id: str, command_type: str, payload: dict[str, Any]) -> dict[str, Any]:
        handler = HANDLERS.get(command_type)
        if handler is None:
            raise ValidationError(f"Unknown command type: {command_type}")
        return self._apply(actor, command_id, command_type, payload, handler)

    def _apply(self, actor, command_id, command_type, payload, handler):
        require_workspace_actor(actor, self.store.workspace_id)
        fingerprint = request_fingerprint(actor, command_type, payload)
        existing = self.store.commands.get(command_id)
        if existing is not None:
            if existing.request_fingerprint != fingerprint:
                raise ConflictError("command_id does not identify the same verified request")
        require_command_authority(self.store, actor, command_type, payload,
                                  existing.result if existing is not None else None)
        require_intake_command_admission(self.store, command_type, payload)
        if existing is not None:
            return deepcopy(existing.result)

        result = handler(self._context, actor, command_id, payload)
        self.store.commands[command_id] = CommandRecord(
            command_id=command_id,
            request_fingerprint=fingerprint,
            type=command_type,
            actor_id=actor.id,
            workspace_id=self.store.workspace_id,
            result=deepcopy(result),
        )
        return result

    def get_work(self, work_id: str) -> Work:
        return self._context.get_work(work_id)

    def get_run(self, run_id: str) -> Run:
        return self._context.get_run(run_id)

    def get_conversation(self, conversation_id: str) -> Conversation:
        return self._context.get_conversation(conversation_id)

    def get_agent(self, agent_id: str) -> AgentProfile:
        return self._context.get_agent(agent_id)

    def get_project(self, project_id: str) -> Project:
        return self._context.get_project(project_id)

    def get_team(self, team_id: str) -> Team:
        return self._context.get_team(team_id)

    def get_grant(self, grant_id: str) -> AccessGrant:
        return self._context.get_grant(grant_id)

    def get_material(self, material_id: str) -> MaterialVersion:
        return self._context.get_material(material_id)

    def current_plan(self, work: Work) -> PlanRevision | None:
        return self._context.current_plan(work)

    def append_engine_message(
        self,
        *,
        actor: Actor,
        command_id: str,
        conversation_id: str,
        author_id: str,
        text: str,
        event_type: str = "message.created",
        event_payload: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        return append_engine_message(self._context, actor=actor, command_id=command_id, conversation_id=conversation_id, author_id=author_id, text=text, event_type=event_type, event_payload=event_payload)

    def ensure_project_for_work(self, actor: Actor, work: Work, *, command_id: str) -> str:
        return ensure_project_for_work(self._context, actor, work, command_id=command_id)

    def register_prepared_material(self, actor: Actor, command_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        require_workspace_actor(actor, self.store.workspace_id)
        require_project_capability(self.store, actor, payload["project_id"], "write")
        # Identity covers the original request, never derived extractor output.
        identity = {key: value for key, value in payload.items()
                    if key not in {"text", "mime_type", "extract_status"}}
        def register(ctx, current_actor, current_id, _identity):
            return register_prepared_material(ctx, current_actor, current_id, payload)
        return self._apply(actor, command_id, "material.ingest", identity, register)
