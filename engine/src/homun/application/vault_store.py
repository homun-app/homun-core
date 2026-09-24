"""Encrypted credential vault store (H40).

Derived from Hermes agent/vault_store.py at c9dca726514b709cf6e677d236a79fc8d0627f37 (MIT).
Provides profile-scoped, Fernet-encrypted credential storage at rest for login,
payment, and address secrets. The model only ever interacts with opaque handles
and metadata; plaintext secret payloads are resolved server-side and automatically
registered for outbound stream redaction.
"""
from __future__ import annotations

import json
import logging
import os
import threading
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from cryptography.fernet import Fernet

from homun.application.secret_redaction import register_vault_redaction_value

logger = logging.getLogger(__name__)

VAULT_KINDS = ("login", "payment", "address", "generic")


@dataclass
class VaultItemMetadata:
    """Opaque metadata exposed to models and API listings."""

    id: str
    kind: str
    label: str
    origin: Optional[str] = None
    created_at: str = ""
    updated_at: str = ""


@dataclass
class _EncryptedVaultRecord:
    metadata: VaultItemMetadata
    encrypted_payload: str


class VaultStore:
    """Encrypted credential vault manager."""

    def __init__(self, vault_dir: Optional[Path] = None) -> None:
        if vault_dir is None:
            homun_home = os.getenv("HOMUN_HOME") or os.path.expanduser("~/.homun")
            self.vault_dir = Path(homun_home) / "vault"
        else:
            self.vault_dir = Path(vault_dir)

        self.vault_dir.mkdir(parents=True, exist_ok=True)
        self._key_file = self.vault_dir / "vault.key"
        self._db_file = self.vault_dir / "vault.json"
        self._lock = threading.Lock()
        self._cipher = self._init_cipher()

    def _init_cipher(self) -> Fernet:
        """Initialize or load the local Fernet encryption key."""
        if not self._key_file.exists():
            key = Fernet.generate_key()
            self._key_file.write_bytes(key)
            try:
                os.chmod(self._key_file, 0o600)
            except OSError:
                pass
        else:
            key = self._key_file.read_bytes().strip()
        return Fernet(key)

    def _load_records(self) -> Dict[str, _EncryptedVaultRecord]:
        if not self._db_file.exists():
            return {}
        try:
            raw = json.loads(self._db_file.read_text(encoding="utf-8"))
            records = {}
            for item_id, item_data in raw.items():
                meta_dict = item_data.get("metadata", {})
                records[item_id] = _EncryptedVaultRecord(
                    metadata=VaultItemMetadata(**meta_dict),
                    encrypted_payload=item_data.get("encrypted_payload", ""),
                )
            return records
        except Exception as exc:
            logger.warning("Failed to load vault records: %s", exc)
            return {}

    def _save_records(self, records: Dict[str, _EncryptedVaultRecord]) -> None:
        data = {
            item_id: {
                "metadata": asdict(record.metadata),
                "encrypted_payload": record.encrypted_payload,
            }
            for item_id, record in records.items()
        }
        tmp_file = self._db_file.with_suffix(".tmp")
        tmp_file.write_text(json.dumps(data, indent=2), encoding="utf-8")
        try:
            os.chmod(tmp_file, 0o600)
        except OSError:
            pass
        tmp_file.replace(self._db_file)

    def store_item(
        self,
        kind: str,
        label: str,
        secret_payload: Dict[str, str],
        *,
        origin: Optional[str] = None,
        item_id: Optional[str] = None,
    ) -> VaultItemMetadata:
        """Store a new credential item encrypted at rest."""
        if kind not in VAULT_KINDS:
            raise ValueError(f"Invalid vault kind '{kind}'; allowed: {VAULT_KINDS}")

        now = datetime.now(timezone.utc).isoformat()
        iid = item_id or f"vlt_{uuid.uuid4().hex[:12]}"
        meta = VaultItemMetadata(
            id=iid,
            kind=kind,
            label=label,
            origin=origin,
            created_at=now,
            updated_at=now,
        )

        # Encrypt the plaintext payload
        payload_bytes = json.dumps(secret_payload).encode("utf-8")
        encrypted = self._cipher.encrypt(payload_bytes).decode("ascii")

        # Automatically register secret values with redactor
        for v in secret_payload.values():
            if isinstance(v, str):
                register_vault_redaction_value(v)

        with self._lock:
            records = self._load_records()
            records[iid] = _EncryptedVaultRecord(metadata=meta, encrypted_payload=encrypted)
            self._save_records(records)

        return meta

    def list_items(self, kind: Optional[str] = None) -> List[VaultItemMetadata]:
        """List all stored items metadata (never returning secrets)."""
        with self._lock:
            records = self._load_records()
            items = [r.metadata for r in records.values()]
        if kind:
            items = [i for i in items if i.kind == kind]
        return sorted(items, key=lambda i: i.created_at, reverse=True)

    def get_item_metadata(self, item_id: str) -> Optional[VaultItemMetadata]:
        """Retrieve item metadata by ID."""
        with self._lock:
            records = self._load_records()
            rec = records.get(item_id)
            return rec.metadata if rec else None

    def resolve_secret_payload(self, item_id: str) -> Optional[Dict[str, str]]:
        """Resolve decrypted payload server-side (for automated fill or authorized export)."""
        with self._lock:
            records = self._load_records()
            rec = records.get(item_id)
            if not rec:
                return None

        try:
            decrypted_bytes = self._cipher.decrypt(rec.encrypted_payload.encode("ascii"))
            payload = json.loads(decrypted_bytes.decode("utf-8"))
            # Register values with redactor to ensure safe handling
            for v in payload.values():
                if isinstance(v, str):
                    register_vault_redaction_value(v)
            return payload
        except Exception as exc:
            logger.error("Failed to decrypt vault item %s: %s", item_id, exc)
            return None

    def delete_item(self, item_id: str) -> bool:
        """Delete a vault item by ID."""
        with self._lock:
            records = self._load_records()
            if item_id in records:
                del records[item_id]
                self._save_records(records)
                return True
            return False
