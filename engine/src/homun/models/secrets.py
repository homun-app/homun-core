"""Secret store for model credentials (F3.1).

Not a substitute for D-CRYPTO-01 / OS keychain. File store is mode 0600 plaintext
on disk and is honest about that — never claim encryption here.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Protocol


class SecretStore(Protocol):
    def put(self, key: str, value: str) -> None: ...

    def get(self, key: str) -> str | None: ...

    def delete(self, key: str) -> None: ...

    def has(self, key: str) -> bool: ...


class MemorySecretStore:
    """In-memory store for unit tests."""

    def __init__(self) -> None:
        self._data: dict[str, str] = {}

    def put(self, key: str, value: str) -> None:
        self._data[key] = value

    def get(self, key: str) -> str | None:
        return self._data.get(key)

    def delete(self, key: str) -> None:
        self._data.pop(key, None)

    def has(self, key: str) -> bool:
        return key in self._data


class FileSecretStore:
    """Local JSON secret file with restrictive permissions. Not encrypted."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        if not self.path.exists():
            self._write({})

    def _read(self) -> dict[str, str]:
        raw = json.loads(self.path.read_text(encoding="utf-8"))
        if not isinstance(raw, dict):
            return {}
        return {str(k): str(v) for k, v in raw.items()}

    def _write(self, data: dict[str, str]) -> None:
        self.path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        try:
            os.chmod(self.path, 0o600)
        except OSError:
            # Windows / restricted FS: best-effort only.
            pass

    def put(self, key: str, value: str) -> None:
        data = self._read()
        data[key] = value
        self._write(data)

    def get(self, key: str) -> str | None:
        return self._read().get(key)

    def delete(self, key: str) -> None:
        data = self._read()
        if key in data:
            del data[key]
            self._write(data)

    def has(self, key: str) -> bool:
        return key in self._read()
