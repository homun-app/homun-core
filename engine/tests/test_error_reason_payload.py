"""Typed error payloads: stable `reason` + `params` next to `code`/`message`.

Disegno: docs/development/2026-10-15-errori-multilingua.md — il motore non
compone frasi per l'utente; restituisce dati stabili e la lingua la sceglie
il client dal catalogo condiviso.
"""
from fastapi import HTTPException

from homun.domain.errors import BudgetExhaustedError, DomainError, NotFoundError, ValidationError
from homun.routes.domain_support import _http_error, error_payload


def test_domain_error_without_reason_stays_compatible():
    exc = ValidationError("plain message")
    assert exc.code == "validation_error"
    assert exc.message == "plain message"
    assert exc.reason is None
    assert exc.params is None


def test_domain_error_carries_reason_and_params():
    exc = ValidationError(
        "left: CSV must be UTF-8",
        reason="comparison.csv.not_utf8",
        params={"side": "comparison.previous"},
    )
    assert exc.reason == "comparison.csv.not_utf8"
    assert exc.params == {"side": "comparison.previous"}


def test_error_payload_without_reason_unchanged():
    exc = NotFoundError("Material not found")
    assert error_payload(exc) == {"code": "not_found", "message": "Material not found"}


def test_error_payload_includes_reason_and_params():
    exc = BudgetExhaustedError(
        "Cannot transition work from draft to running",
        reason="work.transition_invalid",
        params={"from": "work.status.draft", "to": "work.status.running"},
    )
    assert error_payload(exc) == {
        "code": "budget_exhausted",
        "reason": "work.transition_invalid",
        "params": {"from": "work.status.draft", "to": "work.status.running"},
        "message": "Cannot transition work from draft to running",
    }


def test_http_error_detail_matches_payload_and_keeps_status_mapping():
    with_reason = _http_error(
        ValidationError("m", reason="a.b", params={"k": "v"})
    )
    assert isinstance(with_reason, HTTPException)
    assert with_reason.status_code == 400
    assert with_reason.detail == {
        "code": "validation_error",
        "reason": "a.b",
        "params": {"k": "v"},
        "message": "m",
    }

    without_reason = _http_error(DomainError("x"))
    assert without_reason.detail == {"code": "domain_error", "message": "x"}
    assert _http_error(BudgetExhaustedError("b")).status_code == 429
