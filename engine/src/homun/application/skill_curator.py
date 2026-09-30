"""Inactivity-driven skill maintenance.

Derived from Hermes agent/curator.py at c9dca726 (MIT,
NousResearch/hermes-agent), adapted to Homun's domain commands: the curator
archives (never deletes — archive is recoverable) agent-authored skills that
went stale, using the usage counters recorded by skill_view. Person-authored
skills are never touched, and every transition is a journaled skill.archive
command a supervisor can undo with skill.approve.
"""
from __future__ import annotations

import json
import logging
import time
from typing import Any, Dict

logger = logging.getLogger(__name__)

STAGED_TTL_DAYS = 7        # quarantine nobody approved: archive as stale
UNUSED_TTL_DAYS = 30       # approved but never consulted since creation
MIN_INTERVAL_HOURS = 24    # curation cadence gate

_STATE_FILENAME = "skill_curator_state.json"


def _state_path(ctx) -> Any:
    return ctx.data_dir / _STATE_FILENAME


def _load_state(ctx) -> Dict[str, Any]:
    try:
        return json.loads(_state_path(ctx).read_text())
    except Exception:
        return {}


def _save_state(ctx, state: Dict[str, Any]) -> None:
    try:
        _state_path(ctx).write_text(json.dumps(state, ensure_ascii=False, sort_keys=True))
    except Exception:
        logger.warning("Skill curator state could not be persisted", exc_info=True)


def maybe_curate(ctx, *, now: float | None = None, force: bool = False) -> Dict[str, Any] | None:
    """One maintenance pass, interval-gated. Returns a report or None."""
    current = time.time() if now is None else float(now)
    state = _load_state(ctx)
    last = float(state.get("last_run_ts") or 0)
    if not force and (current - last) < MIN_INTERVAL_HOURS * 3600:
        return None
    report = curate(ctx, now=current)
    _save_state(ctx, {"last_run_ts": current, **{k: v for k, v in report.items() if k != "archived"}})
    return report


def curate(ctx, *, now: float) -> Dict[str, Any]:
    from homun.domain.models import Actor, utc_now
    actor = Actor(id="person_local", workspace_id=ctx.workspace_id, display_name="Skill curator")
    archived_staged, archived_unused, skipped = [], [], []
    store = ctx.repository.load()
    candidates = sorted(
        (s for s in store.skills.values() if s.author_type == "agent" and s.status in ("staged", "approved")),
        key=lambda s: s.name,
    )
    for skill in candidates:
        if skill.status == "staged":
            age_days = (utc_now() - skill.updated_at).total_seconds() / 86400
            if age_days < STAGED_TTL_DAYS:
                continue
            outcome = _archive(ctx, actor, skill.id, skill.revision, "staged_stale")
            (archived_staged if outcome else skipped).append(skill.name)
        elif skill.status == "approved" and skill.usage_count == 0:
            age_days = (utc_now() - skill.created_at).total_seconds() / 86400
            if age_days < UNUSED_TTL_DAYS:
                continue
            outcome = _archive(ctx, actor, skill.id, skill.revision, "unused")
            (archived_unused if outcome else skipped).append(skill.name)
    report = {"archived_staged": archived_staged, "archived_unused": archived_unused,
              "skipped": skipped, "archived": len(archived_staged) + len(archived_unused),
              "ran_at": now}
    if report["archived"]:
        logger.info("Skill curator archived %d skills (%d stale staged, %d unused)",
                    report["archived"], len(archived_staged), len(archived_unused))
    return report


def _archive(ctx, actor, skill_id: str, expected_version: int, reason: str) -> bool:
    from homun.domain.errors import DomainError
    try:
        with ctx.repository.locked():
            with ctx.repository.transaction() as store:
                ctx.service.for_store(store).apply(
                    actor, f"curate:{skill_id}:{reason}", "skill.archive",
                    {"skill_id": skill_id, "expected_version": expected_version})
            ctx.service.store = store
        return True
    except DomainError:
        logger.warning("Curator could not archive %s", skill_id, exc_info=True)
        return False
