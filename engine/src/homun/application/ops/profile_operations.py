"""Profile and distribution management for Homun.

Supports profile isolation, config overrides, export/import distribution bundles
with SHA256 integrity verification, and safe switching.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import time
from pathlib import Path
from typing import Any, Dict, List, Optional
from pydantic import BaseModel, Field


class ProfileMetadata(BaseModel):
    name: str = Field(..., description="Unique profile identifier")
    description: str = Field("", description="Human readable description")
    created_at: float = Field(default_factory=time.time)
    updated_at: float = Field(default_factory=time.time)
    parent_profile: Optional[str] = Field(None, description="Parent profile to inherit settings from")
    is_active: bool = False
    config_overrides: Dict[str, Any] = Field(default_factory=dict)
    tags: List[str] = Field(default_factory=list)


class ProfileDistributionPackage(BaseModel):
    manifest_version: int = 1
    profile: ProfileMetadata
    config_content: Dict[str, Any]
    checksum: str = Field(..., description="SHA256 checksum of normalized config")


class ProfileError(Exception):
    """Base error for profile operations."""
    pass


class ProfileNotFoundError(ProfileError):
    """Raised when the specified profile does not exist."""
    pass


class ProfileValidationError(ProfileError):
    """Raised when profile data or integrity checksum is invalid."""
    pass


class ProfileOperationsManager:
    """Manages profile directories, configurations, and distribution bundles."""

    def __init__(self, profiles_dir: Path) -> None:
        self.profiles_dir = profiles_dir
        self.profiles_dir.mkdir(parents=True, exist_ok=True)
        self.active_file = self.profiles_dir / "active_profile"
        self._ensure_default_profile()

    def _ensure_default_profile(self) -> None:
        default_dir = self.profiles_dir / "default"
        if not default_dir.exists():
            default_dir.mkdir(parents=True, exist_ok=True)
            meta = ProfileMetadata(
                name="default",
                description="Default Homun operating profile",
                is_active=True,
            )
            self._save_metadata("default", meta)
            self.set_active_profile("default")

    def _meta_path(self, name: str) -> Path:
        return self.profiles_dir / name / "profile.json"

    def _save_metadata(self, name: str, meta: ProfileMetadata) -> None:
        meta_file = self._meta_path(name)
        meta_file.parent.mkdir(parents=True, exist_ok=True)
        meta.updated_at = time.time()
        meta_file.write_text(json.dumps(meta.model_dump(), indent=2), encoding="utf-8")

    def list_profiles(self) -> List[ProfileMetadata]:
        """List all available profiles."""
        active = self.get_active_profile_name()
        profiles = []
        for entry in self.profiles_dir.iterdir():
            if entry.is_dir() and (entry / "profile.json").exists():
                try:
                    data = json.loads((entry / "profile.json").read_text(encoding="utf-8"))
                    meta = ProfileMetadata(**data)
                    meta.is_active = (meta.name == active)
                    profiles.append(meta)
                except Exception:
                    continue
        return sorted(profiles, key=lambda p: p.name)

    def get_profile(self, name: str) -> ProfileMetadata:
        """Fetch metadata for a specific profile."""
        meta_file = self._meta_path(name)
        if not meta_file.exists():
            raise ProfileNotFoundError(f"Profile '{name}' does not exist")
        data = json.loads(meta_file.read_text(encoding="utf-8"))
        meta = ProfileMetadata(**data)
        meta.is_active = (meta.name == self.get_active_profile_name())
        return meta

    def create_profile(
        self,
        name: str,
        description: str = "",
        parent_profile: Optional[str] = None,
        config_overrides: Optional[Dict[str, Any]] = None,
        tags: Optional[List[str]] = None,
    ) -> ProfileMetadata:
        """Create a new isolated profile."""
        clean_name = name.strip().lower()
        if not clean_name or not clean_name.isalnum():
            raise ProfileValidationError(f"Invalid profile name '{name}'; must be alphanumeric")

        target_dir = self.profiles_dir / clean_name
        if target_dir.exists():
            raise ProfileValidationError(f"Profile '{clean_name}' already exists")

        if parent_profile and not (self.profiles_dir / parent_profile).exists():
            raise ProfileNotFoundError(f"Parent profile '{parent_profile}' does not exist")

        target_dir.mkdir(parents=True, exist_ok=True)
        meta = ProfileMetadata(
            name=clean_name,
            description=description,
            parent_profile=parent_profile,
            config_overrides=config_overrides or {},
            tags=tags or [],
        )
        self._save_metadata(clean_name, meta)
        return meta

    def get_active_profile_name(self) -> str:
        """Get the currently active profile name."""
        if self.active_file.exists():
            val = self.active_file.read_text(encoding="utf-8").strip()
            if val and (self.profiles_dir / val).exists():
                return val
        return "default"

    def set_active_profile(self, name: str) -> None:
        """Switch active profile."""
        clean_name = name.strip()
        if not (self.profiles_dir / clean_name).exists():
            raise ProfileNotFoundError(f"Cannot activate non-existent profile '{clean_name}'")
        self.active_file.write_text(clean_name, encoding="utf-8")

    def export_distribution_package(self, name: str) -> Dict[str, Any]:
        """Export a self-contained distribution package with SHA256 integrity checksum."""
        meta = self.get_profile(name)
        cfg_bytes = json.dumps(meta.config_overrides, sort_keys=True).encode("utf-8")
        checksum = hashlib.sha256(cfg_bytes).hexdigest()

        pkg = ProfileDistributionPackage(
            profile=meta,
            config_content=meta.config_overrides,
            checksum=checksum,
        )
        return pkg.model_dump()

    def import_distribution_package(
        self,
        package_data: Dict[str, Any],
        target_name: Optional[str] = None,
        overwrite: bool = False,
    ) -> ProfileMetadata:
        """Import a distribution package, verifying integrity checksum."""
        pkg = ProfileDistributionPackage(**package_data)

        # Verify integrity
        cfg_bytes = json.dumps(pkg.config_content, sort_keys=True).encode("utf-8")
        calc_checksum = hashlib.sha256(cfg_bytes).hexdigest()
        if calc_checksum != pkg.checksum:
            raise ProfileValidationError(
                f"Integrity check failed: checksum mismatch (expected {pkg.checksum}, got {calc_checksum})"
            )

        name = (target_name or pkg.profile.name).strip().lower()
        if not name or not name.isalnum():
            raise ProfileValidationError(f"Invalid target profile name '{name}'")

        target_dir = self.profiles_dir / name
        if target_dir.exists() and not overwrite:
            raise ProfileValidationError(f"Profile '{name}' already exists and overwrite is False")

        target_dir.mkdir(parents=True, exist_ok=True)
        imported_meta = ProfileMetadata(
            name=name,
            description=pkg.profile.description,
            parent_profile=pkg.profile.parent_profile,
            config_overrides=pkg.config_content,
            tags=pkg.profile.tags,
        )
        self._save_metadata(name, imported_meta)
        return imported_meta

    def delete_profile(self, name: str) -> None:
        """Delete an existing profile (except 'default' and the active profile)."""
        clean_name = name.strip()
        if clean_name == "default":
            raise ProfileValidationError("Cannot delete default profile")
        if clean_name == self.get_active_profile_name():
            raise ProfileValidationError(f"Cannot delete active profile '{clean_name}'")

        target_dir = self.profiles_dir / clean_name
        if not target_dir.exists():
            raise ProfileNotFoundError(f"Profile '{clean_name}' does not exist")

        shutil.rmtree(target_dir)
