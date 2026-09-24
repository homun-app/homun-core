"""Tests for H45 Optional Research: Trajectory Capture, Compression, Batch Evaluations, and Observability."""

import json
from pathlib import Path
import pytest
from fastapi.testclient import TestClient

from homun.app import create_app
from homun.application.trajectory_capture import (
    TrajectoryStore,
    convert_scratchpad_to_think,
    has_incomplete_scratchpad,
)
from homun.application.trajectory_compression import (
    TrajectoryCompressor,
    estimate_tokens,
    estimate_trajectory_tokens,
)
from homun.application.batch_eval_runner import (
    BatchEvalRunner,
    BatchItem,
)
from homun.application.observability_exporter import (
    ObservabilityCollector,
)


def test_trajectory_scratchpad_and_storage(tmp_path: Path):
    store = TrajectoryStore(tmp_path / "trajectories")

    # 1. Scratchpad conversion
    raw_reasoning = "<REASONING_SCRATCHPAD>Need to call tool</REASONING_SCRATCHPAD>I will call the tool."
    assert convert_scratchpad_to_think(raw_reasoning) == "<think>Need to call tool</think>I will call the tool."

    # Incomplete scratchpad detection
    assert has_incomplete_scratchpad("<REASONING_SCRATCHPAD>Started thinking...") is True
    assert has_incomplete_scratchpad("<REASONING_SCRATCHPAD>Done</REASONING_SCRATCHPAD>") is False

    # 2. Append trajectory record
    sample_turns = [
        {"from": "system", "value": "You are Homun."},
        {"from": "human", "value": "Calculate 2+2"},
        {"from": "gpt", "value": "<REASONING_SCRATCHPAD>2+2=4</REASONING_SCRATCHPAD>The answer is 4."},
    ]
    tool_stats = {"terminal": {"count": 1, "success": 1, "failure": 0}}

    record = store.record_trajectory(
        conversations=sample_turns,
        model="hermes-3-llama-3.1-8b",
        completed=True,
        tool_stats=tool_stats,
    )
    assert record.completed is True
    assert record.conversations[2]["value"] == "<think>2+2=4</think>The answer is 4."

    # Read back
    read_entries = store.read_trajectories(limit=10)
    assert len(read_entries) == 1
    assert read_entries[0]["model"] == "hermes-3-llama-3.1-8b"


def test_trajectory_compression_and_invariants():
    compressor = TrajectoryCompressor(target_max_tokens=50, protect_last_n_turns=2)

    # Long trajectory with 10 turns
    long_turns = [
        {"from": "system", "value": "System instructions here."},
        {"from": "human", "value": "First prompt to agent."},
        {"from": "gpt", "value": "First action <tool_call>{\"name\": \"search\"}</tool_call>"},
        {"from": "tool", "value": "<tool_response>result 1</tool_response>"},
        {"from": "human", "value": "Intermediate question 1 which is quite long and detailed."},
        {"from": "gpt", "value": "Intermediate answer 1 which consumes tokens."},
        {"from": "human", "value": "Intermediate question 2 which is also very verbose."},
        {"from": "gpt", "value": "Intermediate answer 2 with lots of words."},
        {"from": "human", "value": "Final user instruction."},
        {"from": "gpt", "value": "Final complete answer delivered to user."},
    ]

    compressed, stats = compressor.compress(long_turns, target_max_tokens=60)

    # Invariants:
    # 1. Head turns (system, initial human, initial gpt, tool response) are preserved
    assert compressed[0]["value"] == "System instructions here."
    assert compressed[1]["value"] == "First prompt to agent."
    assert "<tool_call>" in compressed[2]["value"]
    assert "<tool_response>" in compressed[3]["value"]

    # 2. Middle turns summarized
    assert stats.summarized_turn_count > 0
    assert any("[Summary of" in t["value"] for t in compressed)

    # 3. Tail turns preserved
    assert compressed[-1]["value"] == "Final complete answer delivered to user."
    assert compressed[-2]["value"] == "Final user instruction."


def test_batch_eval_runner_concurrency_and_checkpoint(tmp_path: Path):
    runner = BatchEvalRunner(output_dir=tmp_path / "eval_out", max_workers=2)

    items = [
        BatchItem(id=f"item_{i}", prompt=f"Compute value for index {i}")
        for i in range(5)
    ]

    results, summary = runner.run_batch(items, run_name="test_run", resume=False)

    assert len(results) == 5
    assert summary.completed_items == 5
    assert summary.failed_items == 0
    assert "terminal" in summary.aggregated_tool_stats
    assert summary.aggregated_tool_stats["terminal"]["count"] == 5

    # Test resume: does not re-execute completed items
    resumed_results, resumed_summary = runner.run_batch(items, run_name="test_run", resume=True)
    assert len(resumed_results) == 5


def test_observability_collector_and_traces():
    col = ObservabilityCollector()
    tid = col.start_trace(metadata={"experiment": "parity_h45"})

    span1 = col.start_span(trace_id=tid, name="agent_cycle", kind="agent_turn")
    span2 = col.start_span(
        trace_id=tid,
        name="tool_execution",
        kind="tool_call",
        parent_span_id=span1.span_id,
        attributes={"tool_name": "web_search"},
    )
    col.end_span(trace_id=tid, span_id=span2.span_id, status="ok")
    col.end_span(trace_id=tid, span_id=span1.span_id, status="ok")

    trace = col.get_trace(tid)
    assert len(trace.spans) == 2
    assert trace.spans[0].duration_ms is not None

    # Langfuse payload
    payload = col.export_langfuse_payload(tid)
    assert payload["id"] == tid
    assert len(payload["observations"]) == 2


def test_research_fastapi_endpoints():
    app = create_app()
    client = TestClient(app)

    # 1. Record trajectory
    rec_resp = client.post(
        "/v1/research/trajectories/record",
        json={
            "conversations": [{"from": "human", "value": "ping"}, {"from": "gpt", "value": "pong"}],
            "model": "gpt-mini",
            "completed": True,
        },
    )
    assert rec_resp.status_code == 200

    # 2. Compress trajectory
    comp_resp = client.post(
        "/v1/research/trajectories/compress",
        json={
            "turns": [
                {"from": "system", "value": "System"},
                {"from": "human", "value": "Hi"},
                {"from": "gpt", "value": "Hello"},
            ],
            "target_max_tokens": 1000,
        },
    )
    assert comp_resp.status_code == 200
    assert len(comp_resp.json()["compressed_turns"]) == 3

    # 3. Observability span
    span_resp = client.post(
        "/v1/research/observability/span/start",
        json={"trace_id": "tr_1", "name": "test_span", "kind": "agent_turn"},
    )
    assert span_resp.status_code == 200
    span_id = span_resp.json()["span_id"]

    end_resp = client.post(
        "/v1/research/observability/span/end",
        json={"trace_id": "tr_1", "span_id": span_id, "status": "ok"},
    )
    assert end_resp.status_code == 200
    assert end_resp.json()["status"] == "ok"
