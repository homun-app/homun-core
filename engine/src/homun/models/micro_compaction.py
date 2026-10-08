"""Turn-by-turn micro-compaction of older tool results (H05).

Non-destructively projects message history by compacting verbose tool results
from earlier turns, while preserving recent turns, tool_call_id linkage,
and message structure verbatim.
"""
from __future__ import annotations

from typing import List
from homun.models.native_turn import NativeMessage


def micro_compact_messages(
    messages: List[NativeMessage],
    *,
    max_tool_chars: int = 1200,
    keep_recent_groups: int = 2,
) -> List[NativeMessage]:
    """Return a projected copy of messages with verbose older tool results compacted."""
    if not messages:
        return []

    # 1. Identify tool groups (indices of tool result messages)
    tool_indices: List[int] = []
    for idx, msg in enumerate(messages):
        if msg.role == "tool":
            tool_indices.append(idx)

    if not tool_indices:
        return [m.model_copy(deep=True) for m in messages]

    # Find boundaries of recent groups to protect
    # If keep_recent_groups == 2, protect the last 2 tool messages / groups
    protect_threshold_idx = len(tool_indices) - keep_recent_groups
    indices_to_compact = set(tool_indices[:max(0, protect_threshold_idx)])

    projected: List[NativeMessage] = []
    for idx, msg in enumerate(messages):
        copy_msg = msg.model_copy(deep=True)
        if idx in indices_to_compact and copy_msg.role == "tool" and copy_msg.content:
            raw_len = len(copy_msg.content)
            if raw_len > max_tool_chars:
                head_len = max_tool_chars // 3
                tail_len = max_tool_chars // 3
                head = copy_msg.content[:head_len]
                tail = copy_msg.content[-tail_len:]
                omitted_chars = raw_len - head_len - tail_len
                omitted_lines = copy_msg.content[head_len:-tail_len].count("\n")
                copy_msg.content = (
                    f"{head}\n\n"
                    f"[... {omitted_chars} chars / {omitted_lines} lines micro-compacted for context efficiency ...]\n\n"
                    f"{tail}"
                )
        projected.append(copy_msg)

    return projected
