"""F4.1 receipts — Homun idempotent external effects."""

from __future__ import annotations

from pathlib import Path

import pytest

from homun.runtime.receipts import (
    EffectAlreadyApplied,
    apply_uncertain_effect,
    load_receipt,
    reconcile_or_apply,
)


def test_apply_writes_single_receipt(tmp_path: Path) -> None:
    receipts = tmp_path / "receipts"
    first = apply_uncertain_effect(receipts, "cmd_1", effect="publish_draft_listing")
    assert first.command_id == "cmd_1"
    assert load_receipt(receipts, "cmd_1") is not None
    with pytest.raises(EffectAlreadyApplied):
        apply_uncertain_effect(receipts, "cmd_1")


def test_reconcile_after_crash_simulation(tmp_path: Path) -> None:
    receipts = tmp_path / "receipts"
    with pytest.raises(RuntimeError, match="Simulated timeout"):
        apply_uncertain_effect(receipts, "cmd_crash", crash_after_effect=True)
    assert load_receipt(receipts, "cmd_crash") is not None
    result = reconcile_or_apply(receipts, "cmd_crash")
    assert result["status"] == "reconciled"
    assert len(list(receipts.glob("*.json"))) == 1
