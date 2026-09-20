"""Domain error types."""

from __future__ import annotations


class DomainError(Exception):
    """Base domain failure."""

    code: str = "domain_error"

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


class ValidationError(DomainError):
    code = "validation_error"


class InvalidTransitionError(DomainError):
    code = "invalid_transition"


class ConflictError(DomainError):
    code = "version_conflict"


class PermissionDeniedError(DomainError):
    code = "permission_denied"


class NotFoundError(DomainError):
    code = "not_found"


class CommandInProgressError(DomainError):
    code = "command_in_progress"


class BudgetExhaustedError(DomainError):
    code = "budget_exhausted"
