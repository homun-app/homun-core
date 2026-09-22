"""In-memory workspace store; F2 persists via SqliteWorkspaceRepository."""

from __future__ import annotations

from homun.domain.models import (
    AccessGrant,
    AgentProfile,
    ArtifactVersion,
    CommandRecord,
    ContributionRequest,
    Conversation,
    DomainEvent,
    MaterialVersion,
    Message,
    PlanRevision,
    Project,
    Review,
    Run,
    RuntimeIntent,
    Team,
    Work,
    WorkBudget,
)


class WorkspaceStore:
    def __init__(self, workspace_id: str) -> None:
        self.workspace_id = workspace_id
        self.agents: dict[str, AgentProfile] = {}
        self.teams: dict[str, Team] = {}
        self.projects: dict[str, Project] = {}
        self.grants: dict[str, AccessGrant] = {}
        self.materials: dict[str, MaterialVersion] = {}
        self.conversations: dict[str, Conversation] = {}
        self.messages: dict[str, Message] = {}
        self.works: dict[str, Work] = {}
        self.work_budgets: dict[str, WorkBudget] = {}
        self.outbox: dict[str, RuntimeIntent] = {}
        self.outbox: dict[str, RuntimeIntent] = {}
        self.runs: dict[str, Run] = {}
        self.routines: dict[str, Routine] = {}
        self.plans: dict[str, PlanRevision] = {}  # key: f"{work_id}:{revision}"
        self.contributions: dict[str, ContributionRequest] = {}
        self.artifacts: dict[str, ArtifactVersion] = {}
        self.reviews: dict[str, Review] = {}
        self.events: list[DomainEvent] = []
        self.commands: dict[str, CommandRecord] = {}
        self._sequence = 0
        self._generation = 0  # Persisted optimistic concurrency token.

    def next_sequence(self) -> int:
        self._sequence += 1
        return self._sequence

    def plan_key(self, work_id: str, revision: int) -> str:
        return f"{work_id}:{revision}"
