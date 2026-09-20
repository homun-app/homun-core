"""Idempotent side effects for the uncertain-tool portion of F0.2."""

from __future__ import annotations

import json
from pathlib import Path

from f0_2_runtime.models import UncertainReceipt


class EffectAlreadyApplied(Exception):
    """Raised when a duplicate command would re-apply an external effect."""


def apply_uncertain_effect(
    receipts_dir: Path,
    command_id: str,
    *,
    crash_after_effect: bool = False,
) -> UncertainReceipt:
    """
    Write a receipt for an external effect.

    If crash_after_effect is True, raise after the file exists so a naive
    retry would double-apply unless the step checks the receipt first.
    """
    receipts_dir.mkdir(parents=True, exist_ok=True)
    receipt_path = receipts_dir / f"{command_id}.json"

    if receipt_path.exists():
        existing = UncertainReceipt.model_validate_json(receipt_path.read_text(encoding="utf-8"))
        raise EffectAlreadyApplied(
            f"Effect for {command_id} already applied at {existing.path}; refusing blind retry"
        )

    receipt = UncertainReceipt(
        command_id=command_id,
        effect="publish_draft_listing",
        path=str(receipt_path),
    )
    receipt_path.write_text(receipt.model_dump_json(indent=2), encoding="utf-8")

    if crash_after_effect:
        raise RuntimeError(
            f"Simulated timeout after external effect for {command_id}; receipt already on disk"
        )

    return receipt


def load_receipt(receipts_dir: Path, command_id: str) -> UncertainReceipt | None:
    path = receipts_dir / f"{command_id}.json"
    if not path.exists():
        return None
    return UncertainReceipt.model_validate_json(path.read_text(encoding="utf-8"))


def list_receipts(receipts_dir: Path) -> list[dict[str, object]]:
    if not receipts_dir.exists():
        return []
    items: list[dict[str, object]] = []
    for path in sorted(receipts_dir.glob("*.json")):
        items.append(json.loads(path.read_text(encoding="utf-8")))
    return items
