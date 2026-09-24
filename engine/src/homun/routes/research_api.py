"""FastAPI router for research, evaluation, trajectory compression, and observability."""

from __future__ import annotations

from typing import Any, Dict, List, Optional
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from homun.storage.paths import default_data_dir
from homun.application.trajectory_capture import (
    TrajectorySample,
    TrajectoryStore,
)
from homun.application.trajectory_compression import (
    CompressionStats,
    TrajectoryCompressor,
)
from homun.application.batch_eval_runner import (
    BatchEvalRunner,
    BatchItem,
    BatchItemResult,
    BatchSummary,
)
from homun.application.observability_exporter import (
    ObservabilityCollector,
    ObservabilitySpan,
    ObservabilityTrace,
)

router = APIRouter(prefix="/v1/research", tags=["research"])

_data_dir = default_data_dir()
_trajectory_store = TrajectoryStore(_data_dir / "trajectories")
_trajectory_compressor = TrajectoryCompressor()
_batch_runner = BatchEvalRunner(_data_dir / "eval_batches")
_observability_collector = ObservabilityCollector()


# ── Trajectory Capture Schemas & Endpoints ─────────────────────────────────────

class RecordTrajectoryRequest(BaseModel):
    conversations: List[Dict[str, str]]
    model: str
    completed: bool
    tool_stats: Optional[Dict[str, Dict[str, int]]] = None
    metadata: Optional[Dict[str, Any]] = None


class CompressTrajectoryRequest(BaseModel):
    turns: List[Dict[str, str]]
    target_max_tokens: Optional[int] = 16000


class CompressTrajectoryResponse(BaseModel):
    compressed_turns: List[Dict[str, str]]
    stats: CompressionStats


@router.post("/trajectories/record")
def record_trajectory(req: RecordTrajectoryRequest) -> TrajectorySample:
    return _trajectory_store.record_trajectory(
        conversations=req.conversations,
        model=req.model,
        completed=req.completed,
        tool_stats=req.tool_stats,
        metadata=req.metadata,
    )


@router.get("/trajectories")
def get_trajectories(limit: int = Query(50, ge=1, le=500)) -> List[Dict[str, Any]]:
    return _trajectory_store.read_trajectories(limit=limit)


@router.post("/trajectories/compress")
def compress_trajectory(req: CompressTrajectoryRequest) -> CompressTrajectoryResponse:
    compressed, stats = _trajectory_compressor.compress(
        turns=req.turns,
        target_max_tokens=req.target_max_tokens,
    )
    return CompressTrajectoryResponse(compressed_turns=compressed, stats=stats)


# ── Batch Evaluation Schemas & Endpoints ───────────────────────────────────────

class BatchRunRequest(BaseModel):
    items: List[BatchItem]
    run_name: Optional[str] = "api_batch_run"
    resume: Optional[bool] = False


class BatchRunResponse(BaseModel):
    results: List[BatchItemResult]
    summary: BatchSummary


@router.post("/batch/run")
def run_batch_eval(req: BatchRunRequest) -> BatchRunResponse:
    try:
        results, summary = _batch_runner.run_batch(
            items=req.items,
            run_name=req.run_name or "api_batch_run",
            resume=bool(req.resume),
        )
    except ValueError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return BatchRunResponse(results=results, summary=summary)


# ── Observability Schemas & Endpoints ──────────────────────────────────────────

class StartSpanRequest(BaseModel):
    trace_id: str
    name: str
    kind: Optional[str] = "agent_turn"
    parent_span_id: Optional[str] = None
    attributes: Optional[Dict[str, Any]] = None


class EndSpanRequest(BaseModel):
    trace_id: str
    span_id: str
    status: Optional[str] = "ok"
    error_message: Optional[str] = None
    extra_attributes: Optional[Dict[str, Any]] = None


@router.post("/observability/span/start")
def start_span(req: StartSpanRequest) -> ObservabilitySpan:
    return _observability_collector.start_span(
        trace_id=req.trace_id,
        name=req.name,
        kind=req.kind or "agent_turn",
        parent_span_id=req.parent_span_id,
        attributes=req.attributes,
    )


@router.post("/observability/span/end")
def end_span(req: EndSpanRequest) -> ObservabilitySpan:
    span = _observability_collector.end_span(
        trace_id=req.trace_id,
        span_id=req.span_id,
        status=req.status or "ok",
        error_message=req.error_message,
        extra_attributes=req.extra_attributes,
    )
    if not span:
        raise HTTPException(status_code=404, detail="Span not found")
    return span


@router.get("/observability/trace")
def get_trace(trace_id: str = Query(...)) -> ObservabilityTrace:
    trace = _observability_collector.get_trace(trace_id)
    if not trace:
        raise HTTPException(status_code=404, detail="Trace not found")
    return trace
