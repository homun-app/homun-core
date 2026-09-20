"""Shared command dependencies; feature rules belong to their handlers."""

from __future__ import annotations
from collections.abc import Callable, Iterable
from typing import Any
from pathlib import Path
from homun.domain.errors import ConflictError, NotFoundError, ValidationError
from homun.domain.ids import new_id
from homun.domain.models import AccessGrant, Actor, AgentProfile, Conversation, DomainEvent, MaterialVersion, PlanRevision, Project, Run, Team, Work
from homun.domain.store import WorkspaceStore

class CommandContext:
    """Explicit command dependencies, aggregate lookups and event recording."""

    def __init__(
        self,
        store: WorkspaceStore,
        *,
        known_connection_ids: Callable[[], Iterable[str]] | None = None,
        durable_runtime: bool = False,
        data_dir: Path | None = None,
    ) -> None:
        self.store = store
        self._known_connection_ids = known_connection_ids
        self._durable_runtime = durable_runtime
        self._data_dir = data_dir

    def get_work(self, work_id: str) -> Work:
        work = self.store.works.get(work_id)
        if work is None:
            raise NotFoundError(f"Work not found: {work_id}")
        return work

    def get_run(self, run_id: str) -> Run:
        run = self.store.runs.get(run_id)
        if run is None:
            raise NotFoundError(f"Run not found: {run_id}")
        return run

    def get_conversation(self, conversation_id: str) -> Conversation:
        conversation = self.store.conversations.get(conversation_id)
        if conversation is None:
            raise NotFoundError(f"Conversation not found: {conversation_id}")
        return conversation

    def get_agent(self, agent_id: str) -> AgentProfile:
        agent = self.store.agents.get(agent_id)
        if agent is None:
            raise NotFoundError(f"Agent not found: {agent_id}")
        return agent

    def get_project(self, project_id: str) -> Project:
        project = self.store.projects.get(project_id)
        if project is None:
            raise NotFoundError(f"Project not found: {project_id}")
        return project

    def get_team(self, team_id: str) -> Team:
        team = self.store.teams.get(team_id)
        if team is None:
            raise NotFoundError(f"Team not found: {team_id}")
        return team

    def get_grant(self, grant_id: str) -> AccessGrant:
        grant = self.store.grants.get(grant_id)
        if grant is None:
            raise NotFoundError(f"Grant not found: {grant_id}")
        return grant

    def get_material(self, material_id: str) -> MaterialVersion:
        material = self.store.materials.get(material_id)
        if material is None:
            raise NotFoundError(f"Material not found: {material_id}")
        return material

    def current_plan(self, work: Work) -> PlanRevision | None:
        if work.current_plan_revision < 1:
            return None
        key = self.store.plan_key(work.id, work.current_plan_revision)
        return self.store.plans.get(key)

    def _emit(
        self,
        *,
        actor: Actor,
        command_id: str,
        aggregate_id: str,
        aggregate_type: str,
        aggregate_version: int,
        event_type: str,
        payload: dict[str, Any],
    ) -> DomainEvent:
        event = DomainEvent(
            event_id=new_id("evt"),
            workspace_id=self.store.workspace_id,
            aggregate_id=aggregate_id,
            aggregate_type=aggregate_type,
            aggregate_version=aggregate_version,
            sequence=self.store.next_sequence(),
            type=event_type,
            actor_id=actor.id,
            command_id=command_id,
            payload=payload,
        )
        self.store.events.append(event)
        return event

    def _require_expected_version(self, entity_version: int, expected_version: int | None) -> None:
        if expected_version is None:
            raise ValidationError("expected_version is required")
        if expected_version != entity_version:
            raise ConflictError(
                f"expected_version {expected_version} does not match current {entity_version}"
            )

