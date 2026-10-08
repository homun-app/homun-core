"""Observability and tracing exporter for Homun.

Collects distributed spans (agent turns, tool executions, model inference) compatible
with OpenTelemetry and Langfuse schemas.
"""

from __future__ import annotations

import time
import uuid
from typing import Any, Dict, List, Optional
from pydantic import BaseModel, Field


class ObservabilitySpan(BaseModel):
    trace_id: str
    span_id: str = Field(default_factory=lambda: uuid.uuid4().hex[:16])
    parent_span_id: Optional[str] = None
    name: str
    kind: str = Field("agent_turn", description="agent_turn, tool_call, llm_inference")
    start_time: float = Field(default_factory=time.time)
    end_time: Optional[float] = None
    duration_ms: Optional[float] = None
    status: str = Field("ok", description="ok, error")
    attributes: Dict[str, Any] = Field(default_factory=dict)
    events: List[Dict[str, Any]] = Field(default_factory=list)


class ObservabilityTrace(BaseModel):
    trace_id: str
    spans: List[ObservabilitySpan] = Field(default_factory=list)
    metadata: Dict[str, Any] = Field(default_factory=dict)


class ObservabilityCollector:
    """Collects and exports observability traces."""

    def __init__(self) -> None:
        self._traces: Dict[str, ObservabilityTrace] = {}

    def start_trace(self, trace_id: Optional[str] = None, metadata: Optional[Dict[str, Any]] = None) -> str:
        tid = trace_id or f"trace_{uuid.uuid4().hex[:16]}"
        self._traces[tid] = ObservabilityTrace(trace_id=tid, metadata=metadata or {})
        return tid

    def start_span(
        self,
        trace_id: str,
        name: str,
        kind: str = "agent_turn",
        parent_span_id: Optional[str] = None,
        attributes: Optional[Dict[str, Any]] = None,
    ) -> ObservabilitySpan:
        span = ObservabilitySpan(
            trace_id=trace_id,
            name=name,
            kind=kind,
            parent_span_id=parent_span_id,
            attributes=attributes or {},
        )
        if trace_id not in self._traces:
            self.start_trace(trace_id)
        self._traces[trace_id].spans.append(span)
        return span

    def end_span(
        self,
        trace_id: str,
        span_id: str,
        status: str = "ok",
        error_message: Optional[str] = None,
        extra_attributes: Optional[Dict[str, Any]] = None,
    ) -> Optional[ObservabilitySpan]:
        trace = self._traces.get(trace_id)
        if not trace:
            return None

        for s in trace.spans:
            if s.span_id == span_id:
                s.end_time = time.time()
                s.duration_ms = round((s.end_time - s.start_time) * 1000, 2)
                s.status = status
                if error_message:
                    s.attributes["error"] = error_message
                if extra_attributes:
                    s.attributes.update(extra_attributes)
                return s
        return None

    def export_langfuse_payload(self, trace_id: str) -> Dict[str, Any]:
        """Convert trace to Langfuse ingest payload."""
        trace = self._traces.get(trace_id)
        if not trace:
            return {}

        return {
            "id": trace.trace_id,
            "metadata": trace.metadata,
            "observations": [
                {
                    "id": s.span_id,
                    "traceId": s.trace_id,
                    "parentObservationId": s.parent_span_id,
                    "type": "GENERATION" if s.kind == "llm_inference" else "SPAN",
                    "name": s.name,
                    "startTime": s.start_time,
                    "endTime": s.end_time,
                    "status": s.status,
                    "metadata": s.attributes,
                }
                for s in trace.spans
            ],
        }

    def get_trace(self, trace_id: str) -> Optional[ObservabilityTrace]:
        return self._traces.get(trace_id)
