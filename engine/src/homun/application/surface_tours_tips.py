"""Onboarding tours and contextual tips system for Homun.

Guides users through system capabilities and provides context-aware productivity tips.
"""

from __future__ import annotations

import random
from typing import Any, Dict, List, Optional
from pydantic import BaseModel, Field


class TourStep(BaseModel):
    step_id: str
    title: str
    content: str
    target_surface: str
    action_hint: Optional[str] = None


class Tip(BaseModel):
    id: str
    category: str
    title: str
    body: str
    shortcut: Optional[str] = None


DEFAULT_TOUR_STEPS: List[TourStep] = [
    TourStep(
        step_id="welcome",
        title="Welcome to Homun",
        content="Homun provides supervised autonomous AI execution with strict human-in-the-loop approvals.",
        target_surface="workspace_header",
        action_hint="Read overview and press Next",
    ),
    TourStep(
        step_id="materials",
        title="Project Materials",
        content="Attach domain files, PDFs, or CSV documents. The agent references only authorized sources.",
        target_surface="sidebar_materials",
        action_hint="Click Materials tab",
    ),
    TourStep(
        step_id="approvals",
        title="Write Approvals Gate",
        content="File modifications, destructive commands, and external publishes require explicit confirmation.",
        target_surface="approval_gate",
        action_hint="Inspect before approving",
    ),
    TourStep(
        step_id="deliverables",
        title="Deliverables Mode",
        content="Generated reports, PDFs, and data tables are isolated from code samples and delivered cleanly.",
        target_surface="deliverables_panel",
        action_hint="Review generated artifacts",
    ),
]

DEFAULT_TIPS: List[Tip] = [
    Tip(
        id="side_question",
        category="chat",
        title="Side Questions without Turn Pollution",
        body="Use /btw to ask quick questions without disturbing the main conversation transcript or cache.",
        shortcut="/btw <question>",
    ),
    Tip(
        id="context_mentions",
        category="context",
        title="Targeted @File Mentions",
        body="Mention @file:path:line_start-line_end to inject specific excerpts without reading the whole file.",
        shortcut="@file:src/app.py:10-40",
    ),
    Tip(
        id="deliverable_isolation",
        category="artifacts",
        title="Code Blocks are Protected",
        body="Paths mentioned inside fenced code blocks are never treated as uploaded deliverables.",
    ),
    Tip(
        id="clean_backups",
        category="maintenance",
        title="Automated Config Backups",
        body="Homun creates timestamped backups in config/backups before applying schema migrations.",
    ),
    Tip(
        id="profile_switching",
        category="operations",
        title="Profile Isolation",
        body="Maintain distinct profiles for coding, research, and data analysis using the profile manager.",
    ),
]


class TourAndTipManager:
    """Provides guided tour definitions and tips of the day."""

    def __init__(self) -> None:
        self._tour_steps = DEFAULT_TOUR_STEPS
        self._tips = DEFAULT_TIPS

    def get_tour(self) -> List[TourStep]:
        return self._tour_steps

    def get_tips(self, category: Optional[str] = None) -> List[Tip]:
        if not category:
            return self._tips
        cat_lower = category.lower()
        return [t for t in self._tips if t.category.lower() == cat_lower]

    def get_random_tip(self, category: Optional[str] = None) -> Tip:
        candidates = self.get_tips(category=category)
        return random.choice(candidates) if candidates else self._tips[0]
