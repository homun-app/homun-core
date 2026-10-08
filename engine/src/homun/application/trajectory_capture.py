"""Trajectory capture, formatting, and file-locked persistence for Homun.

Supports ShareGPT format, reasoning scratchpad normalization, tool stats tracking,
and process-safe file-locked append operations.
"""

from __future__ import annotations

import fcntl
import json
import logging
import os
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)


class TrajectoryTurn(BaseModel):
    from_role: str = Field(..., alias="from", description="system, human, gpt, tool")
    value: str = Field(..., description="Message text or tool response")


class TrajectorySample(BaseModel):
    conversations: List[Dict[str, str]]
    timestamp: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    model: str
    completed: bool
    tool_stats: Dict[str, Dict[str, int]] = Field(default_factory=dict)
    metadata: Dict[str, Any] = Field(default_factory=dict)


def convert_scratchpad_to_think(content: str) -> str:
    """Convert <REASONING_SCRATCHPAD> tags to <think> tags."""
    if not content or "<REASONING_SCRATCHPAD>" not in content:
        return content
    return content.replace("<REASONING_SCRATCHPAD>", "<think>").replace("</REASONING_SCRATCHPAD>", "</think>")


def has_incomplete_scratchpad(content: str) -> bool:
    """Check if content has an unclosed reasoning scratchpad."""
    if not content or "<REASONING_SCRATCHPAD>" not in content:
        return False
    return "</REASONING_SCRATCHPAD>" not in content


class TrajectoryStore:
    """Appends trajectory records to disk under exclusive whole-file lock."""

    def __init__(self, output_dir: Path) -> None:
        self.output_dir = output_dir
        self.output_dir.mkdir(parents=True, exist_ok=True)
        self.success_file = self.output_dir / "trajectory_samples.jsonl"
        self.failure_file = self.output_dir / "failed_trajectories.jsonl"

    def _lock_and_append(self, file_path: Path, line: str) -> None:
        file_path.parent.mkdir(parents=True, exist_ok=True)
        with open(file_path, "a", encoding="utf-8") as f:
            fcntl.flock(f.fileno(), fcntl.LOCK_EX)
            try:
                f.write(line)
                f.flush()
            finally:
                fcntl.flock(f.fileno(), fcntl.LOCK_UN)

    def record_trajectory(
        self,
        conversations: List[Dict[str, str]],
        model: str,
        completed: bool,
        tool_stats: Optional[Dict[str, Dict[str, int]]] = None,
        metadata: Optional[Dict[str, Any]] = None,
        custom_file: Optional[Path] = None,
    ) -> TrajectorySample:
        """Format and append a trajectory record with scratchpad conversion."""
        formatted_turns = []
        for turn in conversations:
            role = turn.get("from") or turn.get("role") or "human"
            val = turn.get("value") or turn.get("content") or ""
            formatted_turns.append({"from": role, "value": convert_scratchpad_to_think(val)})

        sample = TrajectorySample(
            conversations=formatted_turns,
            model=model,
            completed=completed,
            tool_stats=tool_stats or {},
            metadata=metadata or {},
        )

        target_path = custom_file or (self.success_file if completed else self.failure_file)
        line = json.dumps(sample.model_dump(), ensure_ascii=False) + "\n"
        self._lock_and_append(target_path, line)
        return sample

    def read_trajectories(self, file_path: Optional[Path] = None, limit: int = 50) -> List[Dict[str, Any]]:
        """Read recent trajectory entries."""
        target = file_path or self.success_file
        if not target.exists():
            return []

        entries = []
        with open(target, "r", encoding="utf-8") as f:
            for line in f:
                stripped = line.strip()
                if stripped:
                    try:
                        entries.append(json.loads(stripped))
                    except json.JSONDecodeError:
                        continue
        return entries[-limit:]
