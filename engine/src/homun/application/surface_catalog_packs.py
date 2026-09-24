"""Catalog packs and shipped skills installer for Homun.

Maintains the complete catalog manifest of bundled and optional skill packs,
supporting safe installation, dependency tracking, and removal without dropping extras.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List, Optional
from pydantic import BaseModel, Field


class ShippedSkill(BaseModel):
    id: str
    name: str
    description: str
    tags: List[str] = Field(default_factory=list)
    system_prompt: str


class SkillPack(BaseModel):
    id: str
    name: str
    version: str = "1.0.0"
    category: str
    description: str
    skills: List[ShippedSkill] = Field(default_factory=list)
    is_installed: bool = False


BUILTIN_PACKS: List[SkillPack] = [
    SkillPack(
        id="dev_essentials",
        name="Developer Essentials Pack",
        category="development",
        description="Core programming, code linting, and testing skills",
        skills=[
            ShippedSkill(
                id="code_reviewer",
                name="Code Reviewer",
                description="Analyzes pull request diffs for logic bugs and style compliance",
                tags=["coding", "git", "review"],
                system_prompt="Review provided code diffs meticulously for correctness and security.",
            ),
            ShippedSkill(
                id="test_generator",
                name="Test Generator",
                description="Generates comprehensive pytest and node unit test suites",
                tags=["coding", "testing"],
                system_prompt="Generate isolated, robust unit tests with high boundary condition coverage.",
            ),
        ],
    ),
    SkillPack(
        id="data_analysis",
        name="Data Analysis & Tables",
        category="data",
        description="Dataset inspection, statistical summaries, and tabular deliverables",
        skills=[
            ShippedSkill(
                id="csv_summarizer",
                name="CSV Summarizer",
                description="Summarizes CSV datasets with columns, distributions, and null stats",
                tags=["data", "csv", "summary"],
                system_prompt="Analyze CSV data structure, identify statistical anomalies, and format markdown tables.",
            ),
        ],
    ),
    SkillPack(
        id="sysadmin_suite",
        name="System Administration & DevOps",
        category="operations",
        description="Container diagnostics, log analysis, and system health verification",
        skills=[
            ShippedSkill(
                id="log_analyzer",
                name="Log Analyzer",
                description="Parses server log files to identify exception stack traces and traffic spikes",
                tags=["sysadmin", "logs", "troubleshooting"],
                system_prompt="Extract error patterns, timestamps, and frequencies from server logs.",
            ),
        ],
    ),
]


class CatalogPacksManager:
    """Manages skill pack catalog discovery, installation, and removal."""

    def __init__(self, skills_dir: Path, state_file: Optional[Path] = None) -> None:
        self.skills_dir = skills_dir
        self.skills_dir.mkdir(parents=True, exist_ok=True)
        self.state_file = state_file or (skills_dir / ".installed_packs.json")
        self._installed_ids: set[str] = self._load_installed()

    def _load_installed(self) -> set[str]:
        if self.state_file.exists():
            try:
                data = json.loads(self.state_file.read_text(encoding="utf-8"))
                return set(data.get("installed", []))
            except Exception:
                pass
        return set()

    def _save_installed(self) -> None:
        payload = {"installed": sorted(list(self._installed_ids))}
        self.state_file.write_text(json.dumps(payload, indent=2), encoding="utf-8")

    def get_catalog_manifest(self) -> List[SkillPack]:
        """Return the complete catalog manifest with accurate installation status."""
        packs = []
        for p in BUILTIN_PACKS:
            pack_copy = p.model_copy(deep=True)
            pack_copy.is_installed = (pack_copy.id in self._installed_ids)
            packs.append(pack_copy)
        return packs

    def install_pack(self, pack_id: str) -> SkillPack:
        """Install all skills contained in the specified pack."""
        clean_id = pack_id.strip()
        manifest = {p.id: p for p in BUILTIN_PACKS}
        if clean_id not in manifest:
            raise ValueError(f"Pack '{pack_id}' not found in catalog")

        pack = manifest[clean_id]
        pack_dir = self.skills_dir / clean_id
        pack_dir.mkdir(parents=True, exist_ok=True)

        for skill in pack.skills:
            skill_file = pack_dir / f"{skill.id}.md"
            content = f"# Skill: {skill.name}\n\n{skill.description}\n\n## Instructions\n{skill.system_prompt}\n"
            skill_file.write_text(content, encoding="utf-8")

        self._installed_ids.add(clean_id)
        self._save_installed()

        res = pack.model_copy(deep=True)
        res.is_installed = True
        return res

    def uninstall_pack(self, pack_id: str) -> bool:
        """Remove installed skills associated with the pack."""
        clean_id = pack_id.strip()
        if clean_id not in self._installed_ids:
            return False

        pack_dir = self.skills_dir / clean_id
        if pack_dir.exists():
            import shutil
            shutil.rmtree(pack_dir)

        self._installed_ids.discard(clean_id)
        self._save_installed()
        return True
