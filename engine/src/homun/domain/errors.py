"""Domain error types."""

from __future__ import annotations


class DomainError(Exception):
    """Base domain failure.

    `message` is technical English for logs and the client's «Dettagli tecnici»;
    the user-facing sentence is composed from `reason` via the shared catalog
    (docs/development/2026-10-15-errori-multilingua.md). Both are optional so
    pre-migration call sites keep working unchanged.
    """

    code: str = "domain_error"

    def __init__(self, message: str, *, reason: str | None = None,
                 params: dict[str, str | int | float] | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.reason = reason
        self.params = params


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


class BackendUnavailableError(DomainError):
    """Raised when a required external or OS backend is not configured or not ready."""

    code = "backend_unavailable"
