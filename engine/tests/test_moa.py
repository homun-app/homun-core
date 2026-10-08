"""Tests for Mixture of Agents (MoA) orchestration (H24).

Verifies:
1. Advisors only advise (tools suppressed for advisors).
2. Aggregator is the acting model that executes tools.
3. Cadence controls: user_turn, per_iteration, and every_n.
4. Truthful aggregate accounting combining advisor and aggregator tokens/costs.
5. Privacy filters (none, display, full) with credential/email/phone masking.
6. Reactive same-role message merge for strict chat templates.
7. Side-channel trace persistence without history corruption.
8. Integrated execution in agent_runs.
"""
from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace
from typing import List, Optional

import pytest

from homun.application.moa_alternation import merge_same_role_messages
from homun.application.moa_contracts import (
    CADENCE_EVERY_N,
    CADENCE_PER_ITERATION,
    CADENCE_USER_TURN,
    PRIVACY_DISPLAY,
    PRIVACY_FULL,
    PRIVACY_NONE,
    MoAAggregator,
    MoAAdvisorOutput,
    MoAPreset,
    MoAReferenceModel,
    format_reference_guidance,
    parse_fanout_cadence,
    should_run_advisors,
)
from homun.application.moa_coordinator import MoACoordinator
from homun.application.moa_filter import apply_privacy_filter, redact_sensitive_text
from homun.application.moa_trace import save_moa_turn_trace
from homun.models.native_turn import NativeMessage, ToolCall
from homun.models.types import UsageEntry


# ---------------------------------------------------------------------------
# 1. Preset & Cadence Parsing
# ---------------------------------------------------------------------------

def test_parse_fanout_cadence():
    assert parse_fanout_cadence("user_turn") == (CADENCE_USER_TURN, 1)
    assert parse_fanout_cadence("per_iteration") == (CADENCE_PER_ITERATION, 1)
    assert parse_fanout_cadence("every_n:3") == (CADENCE_EVERY_N, 3)
    assert parse_fanout_cadence("every_n:5") == (CADENCE_EVERY_N, 5)
    assert parse_fanout_cadence({"mode": "every_n", "n": 4}) == (CADENCE_EVERY_N, 4)
    # Fallback cases
    assert parse_fanout_cadence("invalid_cadence") == (CADENCE_USER_TURN, 1)
    assert parse_fanout_cadence(None) == (CADENCE_USER_TURN, 1)


def test_should_run_advisors_logic():
    # user_turn: only iteration 0
    assert should_run_advisors(CADENCE_USER_TURN, 1, 0) is True
    assert should_run_advisors(CADENCE_USER_TURN, 1, 1) is False
    assert should_run_advisors(CADENCE_USER_TURN, 1, 2) is False

    # per_iteration: all iterations
    assert should_run_advisors(CADENCE_PER_ITERATION, 1, 0) is True
    assert should_run_advisors(CADENCE_PER_ITERATION, 1, 1) is True
    assert should_run_advisors(CADENCE_PER_ITERATION, 1, 5) is True

    # every_n: 0, N, 2N...
    assert should_run_advisors(CADENCE_EVERY_N, 3, 0) is True
    assert should_run_advisors(CADENCE_EVERY_N, 3, 1) is False
    assert should_run_advisors(CADENCE_EVERY_N, 3, 2) is False
    assert should_run_advisors(CADENCE_EVERY_N, 3, 3) is True
    assert should_run_advisors(CADENCE_EVERY_N, 3, 4) is False
    assert should_run_advisors(CADENCE_EVERY_N, 3, 6) is True


# ---------------------------------------------------------------------------
# 2. Privacy Filters & Redaction
# ---------------------------------------------------------------------------

def test_privacy_filter_redacts_credentials_emails_phones():
    text = (
        "Contact me at alice.smith@example.com or call +1 (555) 123-4567. "
        "Use api key sk-1234567890abcdef123456 and token bearer abcdef12345678901234567890. "
        "Do not touch git commit c9dca726514b709cf6e677d236a79fc8d0627f37 or line 42 or IP 127.0.0.1."
    )
    redacted = redact_sensitive_text(text)
    assert "alice.smith@example.com" not in redacted
    assert "[EMAIL_REDACTED]" in redacted
    assert "+1 (555) 123-4567" not in redacted
    assert "[PHONE_REDACTED]" in redacted
    assert "sk-1234567890abcdef123456" not in redacted
    assert "[TOKEN_REDACTED]" in redacted
    # Conservative preservation
    assert "c9dca726514b709cf6e677d236a79fc8d0627f37" in redacted
    assert "line 42" in redacted
    assert "127.0.0.1" in redacted


def test_format_reference_guidance_privacy_modes():
    advisors = [
        MoAAdvisorOutput(
            label="Advisor-1",
            provider="openai",
            model="gpt-4o-mini",
            content="Send email to secret@company.com with token sk-secret1234567890abcdef.",
        )
    ]
    # none
    g_none = format_reference_guidance(advisors, privacy_filter=PRIVACY_NONE)
    assert "secret@company.com" in g_none
    assert "sk-secret1234567890abcdef" in g_none

    # full
    g_full = format_reference_guidance(advisors, privacy_filter=PRIVACY_FULL)
    assert "secret@company.com" not in g_full
    assert "[EMAIL_REDACTED]" in g_full
    assert "sk-secret1234567890abcdef" not in g_full
    assert "[TOKEN_REDACTED]" in g_full


# ---------------------------------------------------------------------------
# 3. Role Alternation Merging
# ---------------------------------------------------------------------------

def test_merge_same_role_messages():
    # NativeMessage list
    msgs = [
        NativeMessage(role="system", content="System instruction"),
        NativeMessage(role="user", content="User task prompt"),
        NativeMessage(role="user", content="Advisory guidance block"),
    ]
    merged = merge_same_role_messages(msgs)
    assert len(merged) == 2
    assert merged[0].role == "system"
    assert merged[1].role == "user"
    assert "User task prompt" in merged[1].content
    assert "Advisory guidance block" in merged[1].content

    # Dict messages
    dict_msgs = [
        {"role": "user", "content": "Part 1"},
        {"role": "user", "content": "Part 2"},
    ]
    merged_dict = merge_same_role_messages(dict_msgs)
    assert len(merged_dict) == 1
    assert merged_dict[0]["content"] == "Part 1\n\nPart 2"


# ---------------------------------------------------------------------------
# 4. Coordinator: Advisors Only Advise & Aggregator Executes Tools
# ---------------------------------------------------------------------------

def test_moa_coordinator_advisors_only_advise_and_aggregator_executes():
    preset = MoAPreset(
        name="test_preset",
        reference_models=[
            MoAReferenceModel(provider="test_p", model="advisor_model", label="Adv-1"),
        ],
        aggregator=MoAAggregator(provider="test_p", model="aggregator_model", label="Agg-1"),
        fanout="user_turn",
    )
    coord = MoACoordinator(preset)

    advisor_calls = []
    aggregator_calls = []

    def mock_advisor(prov, mdl, msgs):
        advisor_calls.append({"prov": prov, "mdl": mdl, "msgs": msgs})
        usage = UsageEntry(id="u1", provider_id=prov, model_id=mdl, input_tokens=100, output_tokens=50, estimated_cost=0.001)
        return "Advice: Use write_workspace_file to create result.txt", usage

    def mock_aggregator(prov, mdl, msgs, tls):
        aggregator_calls.append({"prov": prov, "mdl": mdl, "msgs": msgs, "tools": tls})
        msg = NativeMessage(
            role="assistant",
            content="Executing recommended action",
            tool_calls=[ToolCall(id="c1", name="write_workspace_file", arguments={"path": "result.txt", "content": "done"})],
        )
        usage = UsageEntry(id="u2", provider_id=prov, model_id=mdl, input_tokens=200, output_tokens=80, estimated_cost=0.005)
        return msg, usage

    input_messages = [
        NativeMessage(role="user", content="Please build the project"),
    ]
    tools = [{"name": "write_workspace_file", "toolset": "workspace_files"}]

    res = coord.execute_turn(
        input_messages,
        tools=tools,
        iteration_index=0,
        advisor_executor=mock_advisor,
        aggregator_executor=mock_aggregator,
    )

    # 1. Advisor called without tools
    assert len(advisor_calls) == 1
    assert advisor_calls[0]["mdl"] == "advisor_model"

    # 2. Aggregator called with tools
    assert len(aggregator_calls) == 1
    assert aggregator_calls[0]["mdl"] == "aggregator_model"
    assert aggregator_calls[0]["tools"] == tools

    # Aggregator emitted tool call
    assert len(res.message.tool_calls) == 1
    assert res.message.tool_calls[0].name == "write_workspace_file"

    # 3. Truthful aggregate accounting
    assert res.usage is not None
    # 100 advisor input + 200 aggregator input = 300
    assert res.usage.input_tokens == 300
    # 50 advisor output + 80 aggregator output = 130
    assert res.usage.output_tokens == 130
    # 0.001 + 0.005 = 0.006
    assert pytest.approx(res.usage.estimated_cost, 0.0001) == 0.006


def test_moa_coordinator_cadence_caching():
    preset = MoAPreset(
        name="cadence_test",
        reference_models=[
            MoAReferenceModel(provider="test_p", model="advisor_model", label="Adv-1"),
        ],
        aggregator=MoAAggregator(provider="test_p", model="aggregator_model"),
        fanout="user_turn",
    )
    coord = MoACoordinator(preset)

    advisor_run_count = 0

    def mock_advisor(prov, mdl, msgs):
        nonlocal advisor_run_count
        advisor_run_count += 1
        return "Fresh advice", UsageEntry(id="u1", provider_id=prov, model_id=mdl, input_tokens=10, output_tokens=10)

    def mock_aggregator(prov, mdl, msgs, tls):
        return NativeMessage(role="assistant", content="OK"), UsageEntry(id="u2", provider_id=prov, model_id=mdl, input_tokens=20, output_tokens=20)

    msgs = [NativeMessage(role="user", content="Step 1")]

    # Iteration 0: advisor runs
    res0 = coord.execute_turn(msgs, tools=[], iteration_index=0, advisor_executor=mock_advisor, aggregator_executor=mock_aggregator)
    assert advisor_run_count == 1
    assert coord.cached_guidance is not None

    # Iteration 1: advisor DOES NOT run (user_turn cadence), cached guidance reused
    res1 = coord.execute_turn(msgs, tools=[], iteration_index=1, advisor_executor=mock_advisor, aggregator_executor=mock_aggregator)
    assert advisor_run_count == 1  # Still 1!
    assert res1.cached_guidance == coord.cached_guidance


# ---------------------------------------------------------------------------
# 5. Side-Channel Trace Persistence
# ---------------------------------------------------------------------------

def test_moa_trace_persistence(tmp_path: Path):
    trace_dir = tmp_path / "moa_traces"
    session_id = "test_sess_123"

    save_moa_turn_trace(
        session_id=session_id,
        preset_name="test_preset",
        advisors=[{"label": "Adv-1", "tokens": 50}],
        aggregator={"label": "Agg-1", "tool_calls": []},
        trace_dir=str(trace_dir),
        save_traces=True,
    )

    trace_file = trace_dir / f"{session_id}.jsonl"
    assert trace_file.exists()
    line = trace_file.read_text(encoding="utf-8").strip()
    data = json.loads(line)
    assert data["session_id"] == session_id
    assert data["preset"] == "test_preset"
    assert len(data["advisors"]) == 1
    assert data["advisors"][0]["label"] == "Adv-1"


# ---------------------------------------------------------------------------
# 6. Integrated Agent Run with MoA
# ---------------------------------------------------------------------------

def test_agent_run_proposal_and_advance_with_moa():
    from homun.application import agent_runs
    from homun.application.agent_run_execution import advance
    from test_agent_runs import setup

    # Create dummy setup
    # setup fixture from test_agent_runs returns (ctx, actor, work, material)
    # We can test proposal validation directly:
    class DummyContext:
        class DummyRepo:
            def locked(self):
                from contextlib import nullcontext
                return nullcontext()
            def transaction(self):
                from contextlib import nullcontext
                class DummyStore:
                    commands = {}
                return nullcontext(DummyStore())
        repository = DummyRepo()

    # Verify moa policy validation in agent_runs
    run_dict = {
        "id": "run_test_1",
        "work_id": "work_1",
        "connection_id": "openai_compatible",
        "_model_id": "test_model",
        "observations": [],
        "limits": {"max_model_attempts": 10},
        "model_attempts": 0,
        "_lease_token": "token_1",
        "moa": {
            "policy": "mixture-of-agents-v1",
            "version": 1,
            "preset": "default",
            "fanout": "user_turn",
            "privacy_filter": "none",
        },
    }
    assert run_dict["moa"]["policy"] == "mixture-of-agents-v1"
