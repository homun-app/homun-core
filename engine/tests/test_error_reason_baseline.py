"""Ratchet: error literals without a stable `reason` can only decrease.

The census (tools/census_domain_raises.py) counts DomainError raises without
`reason=` and HTTPException dict details without a reason key; both must stay
at or below tools/error-reasons-baseline.json. To lower the baseline, migrate
raise sites (add reason/params, technical-English message) and update the file.
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "tools"))

from census_domain_raises import (  # noqa: E402
    domain_raises_without_reason,
    http_details_without_reason,
)

BASELINE = json.loads(
    (Path(__file__).resolve().parents[2] / "tools" / "error-reasons-baseline.json")
    .read_text(encoding="utf-8")
)


def test_domain_raises_without_reason_do_not_grow():
    rows = domain_raises_without_reason()
    budget = BASELINE["domain_raises_without_reason"]
    assert len(rows) <= budget, (
        f"{len(rows)} DomainError raises without reason (baseline {budget}). "
        "New errors must carry reason=/params=; if this is a migration, "
        "lower tools/error-reasons-baseline.json. First offenders: "
        + ", ".join(f"{r['file']}:{r['line']}" for r in rows[:5])
    )


def test_http_details_without_reason_do_not_grow():
    rows = http_details_without_reason()
    budget = BASELINE["http_details_without_reason"]
    assert len(rows) <= budget, (
        f"{len(rows)} HTTPException dict details without reason (baseline {budget}). "
        "Literal route errors must carry a reason key; if this is a migration, "
        "lower tools/error-reasons-baseline.json. First offenders: "
        + ", ".join(f"{r['file']}:{r['line']}" for r in rows[:5])
    )
