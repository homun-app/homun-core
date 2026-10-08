"""Tests for path security, URL safety, secret redaction, credential vault, and write approvals (H40)."""
from __future__ import annotations

import tempfile
from pathlib import Path
import pytest
from fastapi.testclient import TestClient

from homun.app import create_app
from homun.application.path_security import (
    check_path_safety,
    has_traversal_component,
    has_unsafe_path_chars,
    is_sensitive_system_path,
    validate_within_dir,
)
from homun.application.secret_redaction import (
    clear_vault_redaction_values,
    mask_token,
    redact_secrets,
    register_vault_redaction_value,
)
from homun.application.url_safety import (
    is_safe_url,
    normalize_url_for_request,
    sensitive_query_param_name,
)
from homun.application.vault_store import VaultStore
from homun.application.write_approval_gate import (
    STATUS_APPROVED,
    STATUS_PENDING,
    STATUS_REJECTED,
    WriteApprovalGate,
    get_write_approval_gate,
    reset_write_approval_gate,
)


@pytest.fixture(autouse=True)
def clean_safety_environment():
    clear_vault_redaction_values()
    reset_write_approval_gate()
    yield
    clear_vault_redaction_values()
    reset_write_approval_gate()


# 1. Path Security
def test_path_security_checks(tmp_path: Path):
    # Traversal detection
    assert has_traversal_component("foo/../bar") is True
    assert has_traversal_component("foo/bar/baz") is False

    # Unsafe chars (newlines, carriage return, null byte)
    assert has_unsafe_path_chars("normal/path.txt") is False
    assert has_unsafe_path_chars("malicious/\x00path.txt") is True
    assert has_unsafe_path_chars("malicious/\npath.txt") is True

    # Directory confinement
    allowed_root = tmp_path / "sandbox"
    allowed_root.mkdir()
    child_file = allowed_root / "data.json"
    child_file.write_text("{}")
    assert validate_within_dir(child_file, allowed_root) is None

    outside_file = tmp_path / "escaped.txt"
    outside_file.write_text("secret")
    assert validate_within_dir(outside_file, allowed_root) is not None

    # Sensitive paths
    assert is_sensitive_system_path(".env") is True
    assert is_sensitive_system_path(".env.local") is True
    assert is_sensitive_system_path("id_rsa") is True
    assert is_sensitive_system_path("/home/user/.ssh/id_ed25519") is True
    assert is_sensitive_system_path("/etc/shadow") is True
    assert is_sensitive_system_path("src/index.ts") is False

    # Overall check_path_safety
    safe, err = check_path_safety(str(child_file), root=str(allowed_root))
    assert safe is True
    assert err is None

    unsafe, err = check_path_safety(str(outside_file), root=str(allowed_root))
    assert unsafe is False
    assert "escapes allowed directory" in (err or "")

    sensitive_target = allowed_root / ".env"
    sensitive_target.write_text("API_KEY=123")
    safe_sens, err_sens = check_path_safety(str(sensitive_target), root=str(allowed_root), allow_sensitive=False)
    assert safe_sens is False
    assert "denied by policy" in (err_sens or "")


# 2. URL Safety and SSRF Prevention
def test_url_safety_and_ssrf():
    # Normalization
    norm = normalize_url_for_request("https://example.com/path with spaces?q=test value")
    assert "https://example.com/path%20with%20spaces?q=test%20value" in norm

    # Sensitive query parameter detection
    assert sensitive_query_param_name("https://api.example.com/data?token=secret123") == "token"
    assert sensitive_query_param_name("https://api.example.com/data?api_key=sk-12345") == "api_key"
    assert sensitive_query_param_name("https://example.com/search?q=weather&page=2") is None

    # Cloud metadata endpoint blocking
    safe, err = is_safe_url("http://169.254.169.254/latest/meta-data/", resolve_dns=False)
    assert safe is False
    assert "cloud metadata endpoint" in (err or "")

    safe_ali, err_ali = is_safe_url("http://100.100.100.200/latest/meta-data/", resolve_dns=False)
    assert safe_ali is False
    assert "cloud metadata endpoint" in (err_ali or "")

    # Hostname blocklist
    safe_gcp, err_gcp = is_safe_url("http://metadata.google.internal/computeMetadata/v1/", resolve_dns=False)
    assert safe_gcp is False
    assert "blocked hostname" in (err_gcp or "")

    # Loopback blocking
    safe_lb, err_lb = is_safe_url("http://127.0.0.1:8000/api", resolve_dns=False)
    assert safe_lb is False
    assert "loopback address" in (err_lb or "")

    # Private IP blocking
    safe_priv, err_priv = is_safe_url("http://192.168.1.100/admin", resolve_dns=False)
    assert safe_priv is False
    assert "private network address" in (err_priv or "")

    # Private allowed when explicitly requested
    safe_allowed, _ = is_safe_url("http://192.168.1.100/admin", allow_private=True, resolve_dns=False)
    assert safe_allowed is True

    # Userinfo credentials rejection
    safe_cred, err_cred = is_safe_url("http://admin:password123@example.com/page", resolve_dns=False)
    assert safe_cred is False
    assert "embedded credentials in userinfo" in (err_cred or "")

    # Sensitive query param rejection
    safe_param, err_param = is_safe_url("https://example.com/webhook?access_token=xyz", resolve_dns=False)
    assert safe_param is False
    assert "sensitive credential query parameter" in (err_param or "")

    # Safe public URL
    safe_pub, err_pub = is_safe_url("https://example.com/docs", resolve_dns=False)
    assert safe_pub is True
    assert err_pub is None


# 3. Secret Redaction
def test_secret_redaction():
    # Mask token helper
    assert mask_token("short123") == "***"
    assert mask_token("sk-proj-1234567890abcdef") == "sk-pro...cdef"

    # API key patterns
    sample_text = (
        "Here is the OpenAI key: sk-proj-1234567890abcdef1234\n"
        "And GitHub token: ghp_123456789012345678901234\n"
        "And AWS key: AKIAIOSFODNN7EXAMPLE\n"
        "Bearer token: Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9\n"
        "Query: https://example.com/auth?api_key=supersecret99887766\n"
    )

    redacted = redact_secrets(sample_text)
    assert "sk-proj-1234567890abcdef1234" not in redacted
    assert "ghp_123456789012345678901234" not in redacted
    assert "AKIAIOSFODNN7EXAMPLE" not in redacted
    assert "supersecret99887766" not in redacted

    # Private key scrubbing
    sample_pkey = (
        "-----BEGIN RSA PRIVATE KEY-----\n"
        "MIIEowIBAAKCAQEA0Y8K...\n"
        "-----END RSA PRIVATE KEY-----\n"
    )
    redacted_pkey = redact_secrets(sample_pkey)
    assert "«redacted-private-key»" in redacted_pkey
    assert "MIIEowIBAAKCAQEA0Y8K" not in redacted_pkey

    # Dynamic vault registration
    register_vault_redaction_value("SecretUserPassword2026!")
    text_with_vault = "The password used for login was SecretUserPassword2026! in session."
    redacted_vault = redact_secrets(text_with_vault)
    assert "SecretUserPassword2026!" not in redacted_vault
    assert "«redacted-vault-secret»" in redacted_vault


# 4. Credential Vault Store
def test_credential_vault_store(tmp_path: Path):
    vault = VaultStore(vault_dir=tmp_path / "vault")

    # Store items
    meta_login = vault.store_item(
        kind="login",
        label="Production DB Login",
        secret_payload={"username": "admin", "password": "SuperSecretPassword123!"},
        origin="https://db.internal",
    )
    assert meta_login.kind == "login"
    assert meta_login.label == "Production DB Login"
    assert meta_login.id.startswith("vlt_")

    meta_pay = vault.store_item(
        kind="payment",
        label="Corporate Card",
        secret_payload={"card_number": "4111222233334444", "cvc": "123"},
    )
    assert meta_pay.kind == "payment"

    # Listing exposes only metadata (never secrets)
    items = vault.list_items()
    assert len(items) == 2
    for item in items:
        assert hasattr(item, "id")
        assert hasattr(item, "kind")
        assert hasattr(item, "label")
        assert not hasattr(item, "secret_payload")
        assert not hasattr(item, "password")

    # Filter by kind
    logins = vault.list_items(kind="login")
    assert len(logins) == 1
    assert logins[0].id == meta_login.id

    # Server-side decryption
    payload = vault.resolve_secret_payload(meta_login.id)
    assert payload is not None
    assert payload["username"] == "admin"
    assert payload["password"] == "SuperSecretPassword123!"

    # Secret value is now registered in redactor
    text = f"Using password {payload['password']} to connect."
    assert "«redacted-vault-secret»" in redact_secrets(text)

    # Deletion
    assert vault.delete_item(meta_pay.id) is True
    assert len(vault.list_items()) == 1
    assert vault.get_item_metadata(meta_pay.id) is None


# 5. Write Approval Gate
def test_write_approval_gate():
    gate = WriteApprovalGate()

    # Stage an action
    record = gate.stage_action(
        subsystem="skills",
        action="install_skill",
        payload={"skill_name": "data_cleaner", "version": "1.0.0"},
        summary="Install data_cleaner skill",
    )
    assert record.status == STATUS_PENDING
    assert record.executed is False

    pending = gate.list_pending(subsystem="skills")
    assert len(pending) == 1
    assert pending[0].id == record.id

    # Approve and execute (single execution contract)
    executed_payloads = []

    def mock_executor(payload):
        executed_payloads.append(payload)
        return {"installed": True}

    ok, res, err = gate.approve_and_execute(record.id, executor=mock_executor)
    assert ok is True
    assert res == {"installed": True}
    assert err is None
    assert len(executed_payloads) == 1
    assert record.status == STATUS_APPROVED
    assert record.executed is True

    # Replay attempt fails: single execution guarantee
    replay_ok, _, replay_err = gate.approve_and_execute(record.id, executor=mock_executor)
    assert replay_ok is False
    assert "already been executed" in (replay_err or "")
    assert len(executed_payloads) == 1  # No second execution!

    # Rejection has zero side-effects and auditable refusal reason
    record2 = gate.stage_action(
        subsystem="memory",
        action="forget_all",
        payload={"scope": "all"},
        summary="Clear all memory records",
    )
    rej_ok, rej_err = gate.reject_action(record2.id, reason="Untrusted bulk deletion")
    assert rej_ok is True
    assert rej_err is None
    assert record2.status == STATUS_REJECTED
    assert record2.rejection_reason == "Untrusted bulk deletion"
    assert record2.executed is False

    # Attempting to approve rejected action fails
    appr_rej_ok, _, appr_rej_err = gate.approve_and_execute(record2.id)
    assert appr_rej_ok is False
    assert "was rejected" in (appr_rej_err or "")


# 6. REST API Routes
def test_safety_api_routes(tmp_path: Path):
    app = create_app()
    client = TestClient(app)

    # 1. POST /v1/safety/path/validate
    resp = client.post(
        "/v1/safety/path/validate",
        json={"path": "src/utils.py", "root": None},
    )
    assert resp.status_code == 200
    assert resp.json()["is_safe"] is True

    resp_bad = client.post(
        "/v1/safety/path/validate",
        json={"path": "foo/../bar", "root": None},
    )
    assert resp_bad.status_code == 200
    assert resp_bad.json()["is_safe"] is False

    # 2. POST /v1/safety/url/validate
    resp_url = client.post(
        "/v1/safety/url/validate",
        json={"url": "http://169.254.169.254/latest/meta-data/", "allow_private": False},
    )
    assert resp_url.status_code == 200
    assert resp_url.json()["is_safe"] is False
    assert "cloud metadata" in resp_url.json()["error"]

    resp_url_ok = client.post(
        "/v1/safety/url/validate",
        json={"url": "https://example.com/api", "allow_private": False},
    )
    assert resp_url_ok.status_code == 200
    assert resp_url_ok.json()["is_safe"] is True

    # 3. POST /v1/safety/redact
    resp_redact = client.post(
        "/v1/safety/redact",
        json={"text": "My OpenAI key is sk-proj-1234567890abcdef1234567890 for testing."},
    )
    assert resp_redact.status_code == 200
    redacted = resp_redact.json()["redacted_text"]
    assert "sk-proj-1234567890abcdef1234567890" not in redacted
    assert "sk-pro...7890" in redacted

    # 4. POST /v1/safety/vault/items & GET /v1/safety/vault/items
    resp_vlt = client.post(
        "/v1/safety/vault/items",
        json={
            "kind": "login",
            "label": "Staging Login",
            "secret_payload": {"username": "qa_user", "password": "QASecretPassword!"},
            "origin": "https://staging.internal",
        },
    )
    assert resp_vlt.status_code == 200
    item_id = resp_vlt.json()["id"]
    assert item_id.startswith("vlt_")

    resp_list = client.get("/v1/safety/vault/items?kind=login")
    assert resp_list.status_code == 200
    assert any(i["id"] == item_id for i in resp_list.json())

    # 5. POST /v1/safety/approvals/stage & resolve
    resp_stage = client.post(
        "/v1/safety/approvals/stage",
        json={
            "subsystem": "skills",
            "action": "upgrade",
            "payload": {"version": "2.0"},
            "summary": "Upgrade skill version",
        },
    )
    assert resp_stage.status_code == 200
    act_id = resp_stage.json()["id"]

    resp_pend = client.get("/v1/safety/approvals/pending")
    assert resp_pend.status_code == 200
    assert any(p["id"] == act_id for p in resp_pend.json())

    resp_res = client.post(
        f"/v1/safety/approvals/{act_id}/resolve",
        json={"decision": "approve"},
    )
    assert resp_res.status_code == 200
    assert resp_res.json()["status"] == "approved"
