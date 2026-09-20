"""Opaque ID helpers for Homun domain entities."""

from __future__ import annotations

import secrets


def new_id(prefix: str) -> str:
    return f"{prefix}_{secrets.token_urlsafe(10)}"
