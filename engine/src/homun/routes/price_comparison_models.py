"""Public comparison contract; runtime bookkeeping never crosses the transport."""
from typing import Any, Literal
from pydantic import BaseModel


class ComparisonSource(BaseModel):
    id: str
    title: str
    sha256: str
    version: int


class ComparisonLimits(BaseModel):
    max_rows: int
    max_attempts: int


class ComparisonProposal(BaseModel):
    id: str
    status: Literal['pending_approval', 'queued', 'running', 'completed', 'failed', 'blocked']
    work_id: str
    digest: str
    expected_version: int
    tool_version: str
    left: ComparisonSource
    right: ComparisonSource
    limits: ComparisonLimits
    report_markdown: str | None = None
    report_csv: str | None = None
    summary: dict[str, Any] | None = None
    error_code: str | None = None
    artifact_id: str | None = None


class ComparisonList(BaseModel):
    items: list[ComparisonProposal]
