"""Reactive same-role message merge for MoA aggregator requests (H24).

Derived from Hermes agent/moa_alternation.py at c9dca726514b709cf6e677d236a79fc8d0627f37 (MIT).
When guidance is attached as an adjacent user turn or when strict-alternation
chat backends reject adjacent user turns, this folds consecutive user messages
into a single combined user turn so strict chat templates do not fail with HTTP 400.
"""
from __future__ import annotations

from typing import Any, Dict, List, Union


def merge_same_role_messages(messages: List[Any]) -> List[Any]:
    """Fold adjacent user messages into one single user message.

    Works with both dict messages and NativeMessage objects.
    Preserves all other messages unchanged.
    """
    if not messages:
        return []

    from homun.models.native_turn import NativeMessage

    is_native = isinstance(messages[0], NativeMessage)

    merged: List[Any] = []
    changed = False

    for msg in messages:
        prev = merged[-1] if merged else None

        if is_native:
            prev_role = prev.role if prev is not None else None
            curr_role = msg.role
        else:
            prev_role = prev.get("role") if prev is not None else None
            curr_role = msg.get("role")

        if prev is not None and prev_role == "user" and curr_role == "user":
            if is_native:
                combined_content = (prev.content.rstrip() + "\n\n" + msg.content.lstrip()).strip()
                merged[-1] = NativeMessage(role="user", content=combined_content)
            else:
                combined_content = (str(prev.get("content") or "").rstrip() + "\n\n" + str(msg.get("content") or "").lstrip()).strip()
                merged[-1] = {**prev, "content": combined_content}
            changed = True
            continue

        merged.append(msg)

    return merged if changed else messages
