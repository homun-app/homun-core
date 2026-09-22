"""Deterministic model suggestions per task, grounded in real local tags.

These are honest heuristics on model size and serving (local vs cloud), not
benchmarks: every suggestion carries its reason, and the person stays free to
choose anything else. The active model is reported, never overridden here.
"""
from __future__ import annotations

OLLAMA_BASE = "http://127.0.0.1:11434"

TASKS = (
    {
        "id": "interpretation",
        "label": "Interpretazione e accordi",
        "hint": "Capire la richiesta e produrre JSON conforme: bastano modelli compatti, la velocità conta.",
    },
    {
        "id": "synthesis",
        "label": "Sintesi e testi del lavoro",
        "hint": "Report, riepiloghi e riscritture: conta la qualità, i modelli più grandi pagano.",
    },
    {
        "id": "chat",
        "label": "Conversazione quotidiana",
        "hint": "Domande e risposte in chat: un buon equilibrio fra qualità e rapidità.",
    },
)


def parse_params_b(parameter_size: str | None) -> float | None:
    """'4.7B' → 4.7, '1T' → 1000.0, '14000000000' → 14.0, unknown → None."""
    if not parameter_size:
        return None
    text = str(parameter_size).strip().upper()
    try:
        if text.endswith("T"):
            return float(text[:-1]) * 1000.0
        if text.endswith("B"):
            return float(text[:-1])
        if text.isdigit():
            return round(float(text) / 1e9, 1)
        return float(text)
    except ValueError:
        return None


def friendly_params(parameter_size: str | None) -> str | None:
    """A readable label for any raw parameter size the daemon reports."""
    params = parse_params_b(parameter_size)
    if params is None:
        return str(parameter_size) if parameter_size else None
    return f"{params:.0f}B" if params < 1000 else f"{params / 1000:.0f}T"


def _fit(task: str, params: float | None, cloud: bool) -> tuple[str, str] | None:
    """(fit, why) for one task, or None when the model does not fit."""
    if task == "interpretation":
        if cloud:
            return ("good", "Modello in cloud: risposta rapida e JSON affidabile.")
        if params is not None and 2.0 <= params <= 12.0:
            return ("best", "Taglia compatta: interpretazioni veloci e JSON stabile.")
        return None
    if task == "synthesis":
        if params is not None and params >= 8.0:
            return ("best", "Taglia grande: sintesi più ricche e coerenti.")
        if cloud:
            return ("good", "In cloud: qualità elevata per testi lunghi.")
        return None
    if task == "chat":
        if cloud:
            return ("good", "Conversazione scorrevole dal cloud.")
        if params is not None and params >= 4.0:
            return ("good", "Abbastanza ampio per una conversazione naturale.")
        if params is not None:
            return ("fair", "Piccolo ma reattivo: ottimo per domande brevi.")
    return None


def recommendations_from_tags(
    tags: list[dict],
    *,
    active_model: str | None,
    cloud_model: str | None = None,
) -> dict:
    """Group the available models by the task they fit best, with reasons."""
    tasks_out = []
    for task in TASKS:
        suggestions = []
        for entry in tags:
            name = str(entry.get("name") or "").strip()
            if not name:
                continue
            details = entry.get("details") if isinstance(entry.get("details"), dict) else {}
            params = parse_params_b(details.get("parameter_size"))
            cloud = name.endswith(":cloud") or (params is not None and params >= 100.0)
            fit = _fit(task["id"], params, cloud)
            if fit is None:
                continue
            fit_kind, why = fit
            suggestions.append({
                "model": name,
                "source": "cloud" if cloud else "ollama",
                "params": friendly_params(details.get("parameter_size")),
                "_params": params,
                "size_gb": round(float(entry.get("size") or 0) / 1e9, 1) or None,
                "fit": fit_kind,
                "why": why,
                "active": bool(active_model and name == active_model),
            })
        # Deterministic order, task-driven: smaller first where speed rules,
        # larger first where quality rules; ties by name.
        smaller_first = task["id"] == "interpretation"
        def _key(item: dict) -> tuple:
            fit_rank = {"best": 0, "good": 1, "fair": 2}[item["fit"]]
            size = item.get("_params") or 0.0
            return (fit_rank, size if smaller_first else -size, item["model"])
        suggestions.sort(key=_key)
        for item in suggestions:
            item.pop("_params", None)
        tasks_out.append({**task, "suggestions": suggestions[:4]})
    if cloud_model:
        for task in tasks_out:
            if any(s["model"] == cloud_model for s in task["suggestions"]):
                continue
            fit = _fit(task["id"], None, cloud=True)
            if fit:
                task["suggestions"].append({
                    "model": cloud_model,
                    "source": "cloud",
                    "params": None,
                    "_params": None,
                    "size_gb": None,
                    "fit": fit[0],
                    "why": fit[1],
                    "active": bool(active_model and cloud_model == active_model),
                })
                def _key_cloud(item: dict) -> tuple:
                    fit_rank = {"best": 0, "good": 1, "fair": 2}[item["fit"]]
                    size = item.get("_params") or 0.0
                    return (fit_rank, size if smaller_first else -size, item["model"])
                task["suggestions"].sort(key=_key_cloud)
                for item in task["suggestions"]:
                    item.pop("_params", None)
    return {"tasks": tasks_out}
