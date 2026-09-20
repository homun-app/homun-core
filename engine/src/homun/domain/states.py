"""Work and step lifecycle states."""

from __future__ import annotations

from enum import StrEnum

from homun.domain.errors import InvalidTransitionError


class WorkStatus(StrEnum):
    DRAFT = "draft"
    READY = "ready"
    RUNNING = "running"
    WAITING_INPUT = "waiting_input"
    WAITING_APPROVAL = "waiting_approval"
    PAUSED = "paused"
    REVIEW = "review"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


class StepStatus(StrEnum):
    PENDING = "pending"
    RUNNING = "running"
    WAITING_INPUT = "waiting_input"
    WAITING_APPROVAL = "waiting_approval"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELLED = "cancelled"
    SUPERSEDED = "superseded"


# Allowed work transitions from architecture doc (F1 subset).
_WORK_TRANSITIONS: dict[WorkStatus, frozenset[WorkStatus]] = {
    WorkStatus.DRAFT: frozenset({WorkStatus.READY, WorkStatus.CANCELLED}),
    WorkStatus.READY: frozenset({WorkStatus.RUNNING, WorkStatus.CANCELLED, WorkStatus.DRAFT}),
    WorkStatus.RUNNING: frozenset(
        {
            WorkStatus.WAITING_INPUT,
            WorkStatus.WAITING_APPROVAL,
            WorkStatus.REVIEW,
            WorkStatus.COMPLETED,
            WorkStatus.PAUSED,
            WorkStatus.FAILED,
            WorkStatus.CANCELLED,
        }
    ),
    WorkStatus.WAITING_INPUT: frozenset(
        {WorkStatus.READY, WorkStatus.CANCELLED, WorkStatus.FAILED}
    ),
    WorkStatus.WAITING_APPROVAL: frozenset(
        {WorkStatus.RUNNING, WorkStatus.CANCELLED, WorkStatus.FAILED}
    ),
    WorkStatus.PAUSED: frozenset({WorkStatus.READY, WorkStatus.CANCELLED}),
    WorkStatus.REVIEW: frozenset({WorkStatus.COMPLETED, WorkStatus.READY, WorkStatus.CANCELLED}),
    WorkStatus.COMPLETED: frozenset(),
    WorkStatus.FAILED: frozenset({WorkStatus.READY, WorkStatus.CANCELLED}),
    WorkStatus.CANCELLED: frozenset(),
}


def assert_work_transition(current: WorkStatus, target: WorkStatus) -> None:
    allowed = _WORK_TRANSITIONS.get(current, frozenset())
    if target not in allowed:
        raise InvalidTransitionError(f"Cannot transition work from {current} to {target}")
