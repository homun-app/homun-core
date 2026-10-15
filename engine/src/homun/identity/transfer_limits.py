"""F5 review P5 — explicit, configurable size limits for object transfers.

A member with `write` could otherwise declare arbitrarily large chunks or
objects and fill the host disk. Limits are validated on the manifest BEFORE
any file is written, and on the chunk body BEFORE it is fully read
(Content-Length + streaming with a hard stop).

Defaults can be overridden per deployment with environment variables, read
at call time so tests and operators can tune them without a restart:

- HOMUN_OBJECT_TRANSFER_MAX_CHUNK_BYTES (default 1 MiB)
- HOMUN_OBJECT_TRANSFER_MAX_CHUNKS_PER_OBJECT (default 4096)
- HOMUN_OBJECT_TRANSFER_MAX_OBJECT_BYTES (default 512 MiB)
- HOMUN_OBJECT_TRANSFER_MAX_PROJECT_BYTES (default 2 GiB)
"""
from __future__ import annotations

import os
from dataclasses import dataclass

from homun.domain.errors import ValidationError
from homun.peers.object_crypto import TransferManifest

MAX_CHUNK_BYTES_DEFAULT = 1_048_576
MAX_CHUNKS_PER_OBJECT_DEFAULT = 4_096
MAX_OBJECT_BYTES_DEFAULT = 536_870_912
MAX_PROJECT_BYTES_DEFAULT = 2_147_483_648


@dataclass(frozen=True)
class TransferLimits:
    max_chunk_bytes: int = MAX_CHUNK_BYTES_DEFAULT
    max_chunks_per_object: int = MAX_CHUNKS_PER_OBJECT_DEFAULT
    max_object_bytes: int = MAX_OBJECT_BYTES_DEFAULT
    max_project_bytes: int = MAX_PROJECT_BYTES_DEFAULT


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError:
        return default
    return value if value > 0 else default


def current_transfer_limits() -> TransferLimits:
    return TransferLimits(
        max_chunk_bytes=_env_int("HOMUN_OBJECT_TRANSFER_MAX_CHUNK_BYTES", MAX_CHUNK_BYTES_DEFAULT),
        max_chunks_per_object=_env_int(
            "HOMUN_OBJECT_TRANSFER_MAX_CHUNKS_PER_OBJECT", MAX_CHUNKS_PER_OBJECT_DEFAULT
        ),
        max_object_bytes=_env_int("HOMUN_OBJECT_TRANSFER_MAX_OBJECT_BYTES", MAX_OBJECT_BYTES_DEFAULT),
        max_project_bytes=_env_int(
            "HOMUN_OBJECT_TRANSFER_MAX_PROJECT_BYTES", MAX_PROJECT_BYTES_DEFAULT
        ),
    )


def validate_manifest_limits(manifest: TransferManifest, limits: TransferLimits) -> None:
    """Typed refusal for manifests beyond the configured ceilings."""
    if len(manifest.chunks) > limits.max_chunks_per_object:
        raise ValidationError(
            f"Manifest declares {len(manifest.chunks)} chunks"
            f" (max {limits.max_chunks_per_object})",
            reason="object_transfer.too_many_chunks",
        )
    oversized = next(
        (chunk for chunk in manifest.chunks if chunk.size > limits.max_chunk_bytes),
        None,
    )
    if oversized is not None:
        raise ValidationError(
            f"Chunk {oversized.index} is {oversized.size} bytes"
            f" (max {limits.max_chunk_bytes})",
            reason="object_transfer.chunk_too_large",
        )
    total = manifest.ciphertext_size()
    if total > limits.max_object_bytes:
        raise ValidationError(
            f"Object is {total} bytes (max {limits.max_object_bytes})",
            reason="object_transfer.object_too_large",
        )


def assert_chunk_size(size: int, limits: TransferLimits) -> None:
    if size > limits.max_chunk_bytes:
        raise ValidationError(
            f"Chunk body is {size} bytes (max {limits.max_chunk_bytes})",
            reason="object_transfer.chunk_too_large",
        )
