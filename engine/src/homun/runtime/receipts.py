"""Homun-owned idempotent receipts for uncertain external effects (F4.1)."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

from pydantic import BaseModel, Field


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


class EffectReceipt(BaseModel):
    command_id: str
    effect: str
    path: str
    created_at: datetime = Field(default_factory=utc_now)


class EffectAlreadyApplied(Exception):
    """Raised when a duplicate command would re-apply an external effect."""


def receipt_path(receipts_dir: Path, command_id: str) -> Path:
    return receipts_dir / f"{command_id}.json"


def load_receipt(receipts_dir: Path, command_id: str) -> EffectReceipt | None:
    path = receipt_path(receipts_dir, command_id)
    if not path.exists():
        return None
    return EffectReceipt.model_validate_json(path.read_text(encoding="utf-8"))


def apply_uncertain_effect(
    receipts_dir: Path,
    command_id: str,
    *,
    effect: str = "publish_draft_listing",
    crash_after_effect: bool = False,
) -> EffectReceipt:
    """
    Write a receipt for an external effect.

    If crash_after_effect is True, raise after the file exists so a naive
    retry would double-apply unless the step checks the receipt first.
    """
    receipts_dir.mkdir(parents=True, exist_ok=True)
    path = receipt_path(receipts_dir, command_id)
    if path.exists():
        existing = EffectReceipt.model_validate_json(path.read_text(encoding="utf-8"))
        raise EffectAlreadyApplied(
            f"Effect for {command_id} already applied at {existing.path}; refusing blind retry"
        )
    receipt = EffectReceipt(command_id=command_id, effect=effect, path=str(path))
    path.write_text(receipt.model_dump_json(indent=2), encoding="utf-8")
    if crash_after_effect:
        raise RuntimeError(
            f"Simulated timeout after external effect for {command_id}; receipt already on disk"
        )
    return receipt


def reconcile_or_apply(
    receipts_dir: Path,
    command_id: str,
    *,
    effect: str = "publish_draft_listing",
    crash_after_effect: bool = False,
) -> dict[str, object]:
    """Idempotent step body: return reconciled if receipt exists, else apply."""
    existing = load_receipt(receipts_dir, command_id)
    if existing is not None:
        return {"status": "reconciled", "receipt": existing.model_dump(mode="json")}
    receipt = apply_uncertain_effect(
        receipts_dir,
        command_id,
        effect=effect,
        crash_after_effect=crash_after_effect,
    )
    return {"status": "applied", "receipt": receipt.model_dump(mode="json")}


def list_receipts(receipts_dir: Path) -> list[dict[str, object]]:
    if not receipts_dir.exists():
        return []
    items: list[dict[str, object]] = []
    for path in sorted(receipts_dir.glob("*.json")):
        items.append(json.loads(path.read_text(encoding="utf-8")))
    return items
