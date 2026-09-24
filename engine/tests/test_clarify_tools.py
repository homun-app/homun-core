"""Tests for human clarification, batched questions, multi-select, and partial timeouts (H08)."""
import json
from types import SimpleNamespace
from homun.application.clarify_contracts import (
    MAX_CHOICES,
    MAX_QUESTIONS,
    RECOMMENDED_LABEL,
    TIMEOUT_RESPONSE,
)
from homun.application.clarify_tools import clarify_tool
from homun.models.native_turn import NativeMessage, ToolCall
from test_agent_runs import setup


def test_clarify_single_question_and_recommendations():
    # 1. Simple question with callback
    def cb1(q, choices, multi_select=False):
        assert q == "Colore preferito?"
        assert choices is None
        return "blu"

    res1 = json.loads(clarify_tool("Colore preferito?", callback=cb1))
    assert res1["question"] == "Colore preferito?"
    assert res1["choices_offered"] is None
    assert res1["user_response"] == "blu"

    # 2. Choices recommended label and trimming
    received_choices = []

    def cb2(q, choices, multi_select=False):
        received_choices.extend(choices)
        return choices[0]  # user picked the recommended choice

    res2 = json.loads(clarify_tool(
        "Seleziona formato",
        choices=["CSV", "JSON", "XML", "PDF", "XLSX"],
        callback=cb2,
    ))
    assert len(received_choices) == MAX_CHOICES
    assert received_choices[0] == f"CSV {RECOMMENDED_LABEL}"
    # Presentation label is stripped from the recorded answer
    assert res2["user_response"] == "CSV"
    assert res2["choices_offered"] == ["CSV", "JSON", "XML", "PDF"]

    # 3. No callback returns clear unavailable error
    res_err = json.loads(clarify_tool("Domanda senza callback"))
    assert "not available" in res_err["error"].lower()


def test_clarify_multi_select():
    # Multi-select with comma-separated return
    def cb_comma(q, choices, multi_select=False):
        assert multi_select is True
        return "rosso, verde"

    res_comma = json.loads(clarify_tool(
        "Seleziona colori",
        choices=["rosso", "verde", "blu"],
        multi_select=True,
        callback=cb_comma,
    ))
    assert res_comma["user_response"] == ["rosso", "verde"]

    # Multi-select with JSON array return
    def cb_json(q, choices, multi_select=False):
        return json.dumps(["blu", "rosso"])

    res_json = json.loads(clarify_tool(
        "Seleziona colori",
        choices=["rosso", "verde", "blu"],
        multi_select=True,
        callback=cb_json,
    ))
    assert res_json["user_response"] == ["blu", "rosso"]


def test_clarify_batched_questions_and_ids():
    received_batch = []

    def cb_batch(q, c, multi_select=False, questions=None):
        received_batch.extend(questions)
        return {
            "answers": {
                "q0": "Approccio B",
                "q1": ["opzione 1", "opzione 2"],
            }
        }

    questions_payload = [
        {
            "id": "arch_decision",
            "question": "Quale architettura adottare?",
            "choices": ["Approccio A", "Approccio B"],
        },
        {
            "question": "Quali componenti attivare?",
            "choices": ["opzione 1", "opzione 2", "opzione 3"],
            "multi_select": True,
        },
    ]

    res = json.loads(clarify_tool("", questions=questions_payload, callback=cb_batch))
    assert len(received_batch) == 2
    assert received_batch[0]["qid"] == "q0"
    assert received_batch[1]["qid"] == "q1"

    responses = res["responses"]
    assert len(responses) == 2
    assert responses[0]["id"] == "arch_decision"
    assert responses[0]["user_response"] == "Approccio B"
    assert responses[1]["user_response"] == ["opzione 1", "opzione 2"]
    assert "timed_out" not in res


def test_clarify_partial_timeout_preserves_completed_answers():
    # Sequential callback where user answers first question then walks away
    calls = []

    def cb_timeout(q, choices, multi_select=False):
        calls.append(q)
        if len(calls) == 2:
            return TIMEOUT_RESPONSE
        return "Risposta a Q1"

    questions_payload = [
        {"question": "Q1: Nome del progetto?"},
        {"question": "Q2: Budget massimo?"},
        {"question": "Q3: Data di consegna?"},
    ]

    res = json.loads(clarify_tool("", questions=questions_payload, callback=cb_timeout))
    assert calls == ["Q1: Nome del progetto?", "Q2: Budget massimo?"]
    assert res["timed_out"] is True
    assert res["responses"][0]["user_response"] == "Risposta a Q1"
    assert res["responses"][1]["user_response"] == ""
    assert res["responses"][2]["user_response"] == ""

    # Batch callback reporting delivery failure notice
    def cb_delivery_fail(q, c, multi_select=False, questions=None):
        return {
            "answers": {"q0": "Salvato"},
            "timed_out": True,
            "notice": "Connessione del client interrotta",
        }

    res_fail = json.loads(clarify_tool("", questions=questions_payload[:2], callback=cb_delivery_fail))
    assert res_fail["timed_out"] is True
    assert res_fail["notice"] == "Connessione del client interrotta"
    assert res_fail["responses"][0]["user_response"] == "Salvato"
    assert res_fail["responses"][1]["user_response"] == ""


def test_agent_run_advances_with_clarify_tool(setup):
    from homun.application import agent_runs
    from homun.application.agent_run_execution import advance

    ctx, actor, work, _ = setup
    ctx.models.set_active("openai_compatible")

    proposal = agent_runs.propose(ctx, actor, work, {
        "command_id": "run_clarify_agent",
        "expected_version": 1,
        "material_ids": [],
        "clarify": True,
    })
    tool_names = [t["name"] for t in proposal["tools"]]
    assert proposal["clarify"] == {"policy": "structured-clarify-v1", "version": 1}
    assert "clarify" in tool_names

    agent_runs.approve(ctx, actor, work, proposal["id"], {
        "command_id": "approve_clarify_agent",
        "digest": proposal["digest"],
        "expected_version": proposal["expected_version"],
    })

    # Prepare answers in run so clarify resolves cleanly
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            run_cmd = store.commands[proposal["id"]].result
            run_cmd["_clarify_answers"] = {
                "q0": "Report sintetico",
            }
        ctx.service.store = store

    ctx.models.complete_tools = lambda *a, **k: SimpleNamespace(
        message=NativeMessage(
            role="assistant",
            tool_calls=[
                ToolCall(
                    id="call_clar1",
                    name="clarify",
                    arguments={
                        "questions": [
                            {"question": "Che tipo di report desideri?", "choices": ["Report sintetico", "Report esteso"]}
                        ]
                    },
                )
            ],
        ),
        usage=None,
    )

    assert advance(ctx, proposal["id"]) == "running"
    cmd = ctx.repository.load().commands[proposal["id"]]
    obs = cmd.result["observations"][-1]
    assert obs["tool"] == "clarify"
    assert obs["result"]["responses"][0]["user_response"] == "Report sintetico"
