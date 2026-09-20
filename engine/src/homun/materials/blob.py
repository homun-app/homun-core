"""Idempotent blob paths for ingested material originals."""

from __future__ import annotations

from pathlib import Path


def material_blob_path(data_dir: Path, material_id: str, version: int) -> Path:
    return data_dir / "materials" / material_id / f"v{version}" / "original"


def write_material_blob(
    data_dir: Path,
    *,
    material_id: str,
    version: int,
    data: bytes,
) -> str:
    """Write original bytes; return storage_relpath relative to data_dir."""
    path = material_blob_path(data_dir, material_id, version)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return str(path.relative_to(data_dir))


def read_material_blob(data_dir: Path, storage_relpath: str, *, max_bytes: int | None = None) -> bytes:
    path = (data_dir / storage_relpath).resolve()
    root = data_dir.resolve()
    if not path.is_relative_to(root):
        raise ValueError("Blob path escapes data_dir")
    if max_bytes is None:
        return path.read_bytes()
    with path.open('rb') as stream:
        data = stream.read(max_bytes + 1)
    if len(data) > max_bytes:
        raise ValueError('Blob exceeds the requested byte limit')
    return data
