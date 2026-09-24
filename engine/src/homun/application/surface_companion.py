"""Virtual companion (pet) and skin management for Homun.

Provides interactive pet companion state, skins, hunger/energy mechanics,
and toggleable activation.
"""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any, Dict, List, Optional
from pydantic import BaseModel, Field


class PetSkin(BaseModel):
    id: str
    name: str
    description: str
    ascii_art: str


AVAILABLE_SKINS: Dict[str, PetSkin] = {
    "default": PetSkin(
        id="default",
        name="Classic Homun",
        description="Standard friendly mechanical companion",
        ascii_art="( ^ _ ^ )",
    ),
    "cyberpunk": PetSkin(
        id="cyberpunk",
        name="Cyberpunk Neon",
        description="High-tech glow aesthetic",
        ascii_art="[ [ • _ • ] ]",
    ),
    "retro_ascii": PetSkin(
        id="retro_ascii",
        name="Retro Terminal",
        description="Classic VT100 phosphor green look",
        ascii_art="<:o_o:>",
    ),
    "lofi": PetSkin(
        id="lofi",
        name="Lofi Cozy",
        description="Relaxed study companion",
        ascii_art="( - . - ) zZ",
    ),
}


class PetState(BaseModel):
    enabled: bool = True
    name: str = "Homun"
    species: str = "Automaton"
    active_skin: str = "default"
    level: int = 1
    experience: int = 0
    hunger: int = 100  # 100 = full, 0 = starving
    energy: int = 100  # 100 = energetic, 0 = exhausted
    mood: str = "happy"  # happy, sleepy, hungry, focused
    last_interaction: float = Field(default_factory=time.time)


class CompanionManager:
    """Manages virtual companion state, skin customization, and interactions."""

    def __init__(self, state_file: Path) -> None:
        self.state_file = state_file
        self.state_file.parent.mkdir(parents=True, exist_ok=True)
        self._state = self._load()

    def _load(self) -> PetState:
        if self.state_file.exists():
            try:
                data = json.loads(self.state_file.read_text(encoding="utf-8"))
                return PetState(**data)
            except Exception:
                pass
        st = PetState()
        self._save(st)
        return st

    def _save(self, state: PetState) -> None:
        self.state_file.write_text(json.dumps(state.model_dump(), indent=2), encoding="utf-8")
        self._state = state

    def get_state(self) -> PetState:
        return self._state

    def set_enabled(self, enabled: bool) -> PetState:
        self._state.enabled = enabled
        self._save(self._state)
        return self._state

    def set_skin(self, skin_id: str) -> PetState:
        clean = skin_id.strip().lower()
        if clean not in AVAILABLE_SKINS:
            raise ValueError(f"Unknown skin '{skin_id}'. Available: {list(AVAILABLE_SKINS.keys())}")
        self._state.active_skin = clean
        self._save(self._state)
        return self._state

    def feed(self) -> PetState:
        self._state.hunger = min(100, self._state.hunger + 30)
        self._state.experience += 10
        self._update_level()
        self._state.last_interaction = time.time()
        self._state.mood = "happy"
        self._save(self._state)
        return self._state

    def play(self) -> PetState:
        self._state.energy = max(0, self._state.energy - 20)
        self._state.hunger = max(0, self._state.hunger - 15)
        self._state.experience += 25
        self._update_level()
        self._state.last_interaction = time.time()
        self._state.mood = "focused" if self._state.energy > 30 else "sleepy"
        self._save(self._state)
        return self._state

    def rest(self) -> PetState:
        self._state.energy = 100
        self._state.mood = "happy"
        self._state.last_interaction = time.time()
        self._save(self._state)
        return self._state

    def _update_level(self) -> None:
        needed = self._state.level * 100
        if self._state.experience >= needed:
            self._state.level += 1
            self._state.experience -= needed

    def render(self) -> Dict[str, Any]:
        skin = AVAILABLE_SKINS.get(self._state.active_skin, AVAILABLE_SKINS["default"])
        return {
            "name": self._state.name,
            "skin": skin.name,
            "ascii": skin.ascii_art,
            "mood": self._state.mood,
            "level": self._state.level,
            "hunger": self._state.hunger,
            "energy": self._state.energy,
            "enabled": self._state.enabled,
        }
