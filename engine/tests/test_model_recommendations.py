"""Model suggestions per task: honest heuristics on the real local catalog."""
from homun.application.model_recommendations import (
    parse_params_b,
    recommendations_from_tags,
)


def test_parse_params_b():
    assert parse_params_b("4.7B") == 4.7
    assert parse_params_b("1T") == 1000.0
    assert parse_params_b(None) is None
    assert parse_params_b("n/d") is None


def _tags():
    return [
        {"name": "qwen3.5:2b", "size": 2.7e9,
         "details": {"parameter_size": "2.3B", "quantization_level": "Q8_0"}},
        {"name": "qwen3.5:4b", "size": 3.4e9,
         "details": {"parameter_size": "4.7B", "quantization_level": "Q4_K_M"}},
        {"name": "gemma4:12b", "size": 7.6e9,
         "details": {"parameter_size": "11.9B", "quantization_level": "Q4_K_M"}},
        {"name": "kimi-k2.6:cloud", "size": 0,
         "details": {"parameter_size": "1T", "quantization_level": "int4"}},
    ]


def test_suggestions_group_by_task_with_reasons_and_order():
    out = recommendations_from_tags(_tags(), active_model="qwen3.5:4b")
    tasks = {t["id"]: t for t in out["tasks"]}
    interp = [s["model"] for s in tasks["interpretation"]["suggestions"]]
    synth = [s["model"] for s in tasks["synthesis"]["suggestions"]]
    assert interp[0] == "qwen3.5:2b"  # per l'interpretazione vince il più piccolo e veloce
    assert "kimi-k2.6:cloud" in interp
    assert synth[0] in {"gemma4:12b", "kimi-k2.6:cloud"}  # grandi prima per la sintesi
    assert "qwen3.5:2b" not in synth  # troppo piccolo per la sintesi
    active = [s for t in out["tasks"] for s in t["suggestions"] if s["active"]]
    assert {s["model"] for s in active} == {"qwen3.5:4b"}
    every = [s for t in out["tasks"] for s in t["suggestions"]]
    assert all(s["why"] for s in every)  # ogni suggerimento dice perché


def test_cloud_model_from_credentials_is_included_when_set():
    tags = [t for t in _tags() if not t["name"].endswith(":cloud")]
    out = recommendations_from_tags(tags, active_model="gpt-big", cloud_model="gpt-big")
    interp = [s["model"] for s in out["tasks"][0]["suggestions"]]
    assert "gpt-big" in interp
    assert any(s["active"] for s in out["tasks"][0]["suggestions"] if s["model"] == "gpt-big")


def test_empty_catalog_returns_empty_task_lists_not_errors():
    out = recommendations_from_tags([], active_model=None)
    assert all(t["suggestions"] == [] for t in out["tasks"])
