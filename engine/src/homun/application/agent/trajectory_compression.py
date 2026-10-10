"""Trajectory compression engine for Homun.

Compresses long multi-turn trajectories to fit token budgets while protecting
head context (system, initial user, first action) and tail turns, never splitting
tool call/response pairs.
"""

from __future__ import annotations

import math
import re
from typing import Any, Dict, List, Optional, Tuple
from pydantic import BaseModel, Field


class CompressionStats(BaseModel):
    original_turns: int
    compressed_turns: int
    estimated_original_tokens: int
    estimated_compressed_tokens: int
    compression_ratio: float
    summarized_turn_count: int


def estimate_tokens(text: str) -> int:
    """Rough token estimation (approx 4 characters per token)."""
    if not text:
        return 0
    return max(1, math.ceil(len(text) / 4.0))


def estimate_trajectory_tokens(turns: List[Dict[str, str]]) -> int:
    """Estimate total tokens across a list of turns."""
    return sum(estimate_tokens(t.get("value", "")) for t in turns)


class TrajectoryCompressor:
    """Compresses agent trajectories to respect strict token limits."""

    def __init__(
        self,
        target_max_tokens: int = 16000,
        protect_last_n_turns: int = 3,
        summary_notice_template: str = "[Summary of {count} intermediate turns: executed tasks and tools without errors]",
    ) -> None:
        self.target_max_tokens = target_max_tokens
        self.protect_last_n_turns = max(1, protect_last_n_turns)
        self.summary_notice_template = summary_notice_template

    def compress(
        self,
        turns: List[Dict[str, str]],
        target_max_tokens: Optional[int] = None,
    ) -> Tuple[List[Dict[str, str]], CompressionStats]:
        """Compress trajectory if it exceeds the target token budget."""
        target_budget = target_max_tokens or self.target_max_tokens
        orig_tokens = estimate_trajectory_tokens(turns)
        orig_count = len(turns)

        if orig_tokens <= target_budget or orig_count <= (self.protect_last_n_turns + 4):
            # Already fits within budget or too short to compress
            return turns, CompressionStats(
                original_turns=orig_count,
                compressed_turns=orig_count,
                estimated_original_tokens=orig_tokens,
                estimated_compressed_tokens=orig_tokens,
                compression_ratio=1.0,
                summarized_turn_count=0,
            )

        # Identify head boundary: protect system, first human, first gpt, first tool
        head_indices = set()
        seen_system = False
        seen_human = False
        seen_gpt = False
        seen_tool = False

        for idx, turn in enumerate(turns):
            role = turn.get("from") or turn.get("role") or ""
            val = turn.get("value", "")
            if role == "system" and not seen_system:
                head_indices.add(idx)
                seen_system = True
            elif role == "human" and not seen_human:
                head_indices.add(idx)
                seen_human = True
            elif role == "gpt" and not seen_gpt:
                head_indices.add(idx)
                seen_gpt = True
                if "<tool_call>" in val:
                    # Also include matching response if next turn is tool
                    if idx + 1 < len(turns):
                        head_indices.add(idx + 1)
                        seen_tool = True
            elif (role == "tool" or "<tool_response>" in val) and not seen_tool:
                head_indices.add(idx)
                seen_tool = True

            if len(head_indices) >= 4 or idx >= 5:
                break

        head_end = max(head_indices) + 1 if head_indices else 1
        tail_start = max(head_end, orig_count - self.protect_last_n_turns)

        # Ensure we do not split a tool_call / tool_response pair at boundaries
        if tail_start < orig_count:
            tail_turn_val = turns[tail_start].get("value", "")
            if "<tool_response>" in tail_turn_val or turns[tail_start].get("from") == "tool":
                # Shift tail start back by 1 so the tool_call remains paired with its response
                tail_start = max(head_end, tail_start - 1)

        head_slice = turns[:head_end]
        tail_slice = turns[tail_start:]
        middle_slice = turns[head_end:tail_start]

        if not middle_slice:
            return turns, CompressionStats(
                original_turns=orig_count,
                compressed_turns=orig_count,
                estimated_original_tokens=orig_tokens,
                estimated_compressed_tokens=orig_tokens,
                compression_ratio=1.0,
                summarized_turn_count=0,
            )

        # Generate summary turn for middle turns
        summary_text = self.summary_notice_template.format(count=len(middle_slice))
        summary_turn = {"from": "human", "value": summary_text}

        compressed_turns = head_slice + [summary_turn] + tail_slice
        comp_tokens = estimate_trajectory_tokens(compressed_turns)

        return compressed_turns, CompressionStats(
            original_turns=orig_count,
            compressed_turns=len(compressed_turns),
            estimated_original_tokens=orig_tokens,
            estimated_compressed_tokens=comp_tokens,
            compression_ratio=round(comp_tokens / max(1, orig_tokens), 3),
            summarized_turn_count=len(middle_slice),
        )
