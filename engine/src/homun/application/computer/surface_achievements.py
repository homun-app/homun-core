"""Achievement tracker and gamification system for Homun.

Maintains achievement catalog, tracks user milestones, and persists unlocks.
"""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any, Dict, List, Optional
from pydantic import BaseModel, Field


class Achievement(BaseModel):
    id: str
    title: str
    description: str
    icon: str
    points: int
    unlocked_at: Optional[float] = None
    progress: float = 0.0  # 0.0 to 1.0


DEFAULT_ACHIEVEMENTS: List[Achievement] = [
    Achievement(
        id="first_tool_call",
        title="First Contact",
        description="Execute your very first tool call in Homun",
        icon="🛠️",
        points=10,
    ),
    Achievement(
        id="clean_sweep",
        title="Pristine Workspace",
        description="Run a disk cleanup scan and reclaim workspace space",
        icon="🧹",
        points=20,
    ),
    Achievement(
        id="master_coder",
        title="Code Artisan",
        description="Successfully execute an approved workspace file patch",
        icon="💻",
        points=30,
    ),
    Achievement(
        id="night_owl",
        title="Midnight Oil",
        description="Complete an agent run between midnight and 5:00 AM",
        icon="🦉",
        points=15,
    ),
    Achievement(
        id="polyglot",
        title="Polyglot Agent",
        description="Execute commands or prompts across multiple model providers",
        icon="🌐",
        points=25,
    ),
]


class AchievementTracker:
    """Tracks and records user and agent milestones."""

    def __init__(self, storage_file: Path) -> None:
        self.storage_file = storage_file
        self.storage_file.parent.mkdir(parents=True, exist_ok=True)
        self._achievements = self._load()

    def _load(self) -> Dict[str, Achievement]:
        achievements_map = {a.id: a.model_copy() for a in DEFAULT_ACHIEVEMENTS}
        if self.storage_file.exists():
            try:
                data = json.loads(self.storage_file.read_text(encoding="utf-8"))
                for item in data:
                    ach = Achievement(**item)
                    achievements_map[ach.id] = ach
            except Exception:
                pass
        return achievements_map

    def _save(self) -> None:
        raw = [a.model_dump() for a in self._achievements.values()]
        self.storage_file.write_text(json.dumps(raw, indent=2), encoding="utf-8")

    def list_all(self) -> List[Achievement]:
        return list(self._achievements.values())

    def unlock(self, achievement_id: str) -> Optional[Achievement]:
        ach = self._achievements.get(achievement_id)
        if not ach:
            return None

        if ach.unlocked_at is None:
            ach.unlocked_at = time.time()
            ach.progress = 1.0
            self._save()
        return ach

    def get_score(self) -> Dict[str, Any]:
        unlocked = [a for a in self._achievements.values() if a.unlocked_at is not None]
        total_points = sum(a.points for a in unlocked)
        return {
            "total_unlocked": len(unlocked),
            "total_available": len(self._achievements),
            "score": total_points,
            "completion_percentage": round((len(unlocked) / len(self._achievements)) * 100, 1),
        }
