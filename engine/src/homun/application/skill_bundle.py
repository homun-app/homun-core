"""Skill bundles, multi-skill packaging, and atomic bundle installation (H20).

Provides portable bundling of multiple procedural skills with versioning,
integrity checksums, and quarantine-aware installation into the Homun skill store.
"""
from __future__ import annotations

import hashlib
import json
import uuid
from typing import Any, Dict, List, Optional, Tuple

from homun.domain.errors import ValidationError
from homun.domain.models import Skill, utc_now


def compute_bundle_checksum(skills_payload: List[Dict[str, Any]]) -> str:
    """Compute a deterministic SHA256 checksum over normalized skill entries."""
    serialized = json.dumps(skills_payload, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(serialized.encode("utf-8")).hexdigest()


def export_skill_bundle(
    skills: List[Dict[str, Any]],
    bundle_name: str,
    *,
    description: str = "",
    author: str = "homun",
) -> Dict[str, Any]:
    """Package a list of skills into a versioned bundle manifest."""
    if not bundle_name.strip():
        raise ValidationError("bundle_name cannot be empty")
    if not skills:
        raise ValidationError("Cannot export an empty skill bundle")

    normalized_skills: List[Dict[str, Any]] = []
    for s in skills:
        name = str(s.get("name") or "").strip()
        body = str(s.get("body") or "").strip()
        if not name or not body:
            raise ValidationError(f"Skill entry missing name or body: {s}")
        normalized_skills.append({
            "name": name,
            "description": str(s.get("description") or "").strip(),
            "body": body,
            "tags": sorted([str(t).strip() for t in (s.get("tags") or []) if str(t).strip()]),
            "author_type": str(s.get("author_type") or "user"),
        })

    normalized_skills.sort(key=lambda item: item["name"])
    checksum = compute_bundle_checksum(normalized_skills)

    return {
        "bundle_version": "1.0",
        "bundle_name": bundle_name.strip(),
        "description": description.strip(),
        "author": author.strip(),
        "created_at": utc_now().isoformat(),
        "checksum": checksum,
        "skills_count": len(normalized_skills),
        "skills": normalized_skills,
    }


def validate_skill_bundle(bundle: Dict[str, Any]) -> Tuple[bool, Optional[str]]:
    """Validate the integrity and format of a skill bundle manifest."""
    if not isinstance(bundle, dict):
        return False, "Bundle must be a dictionary"
    if bundle.get("bundle_version") != "1.0":
        return False, f"Unsupported bundle version: {bundle.get('bundle_version')}"
    skills = bundle.get("skills")
    if not isinstance(skills, list) or not skills:
        return False, "Bundle contains no skills"

    expected_checksum = bundle.get("checksum")
    if not expected_checksum:
        return False, "Bundle is missing checksum"

    actual_checksum = compute_bundle_checksum(skills)
    if actual_checksum != expected_checksum:
        return False, "Bundle checksum mismatch"

    for s in skills:
        if not isinstance(s, dict) or not s.get("name") or not s.get("body"):
            return False, "Invalid skill entry in bundle"

    return True, None


def install_skill_bundle(
    ctx: Any,
    actor: Any,
    bundle: Dict[str, Any],
    *,
    status: str = "staged",
) -> Dict[str, Any]:
    """Install a skill bundle into the repository with quarantine/approval support."""
    is_valid, err = validate_skill_bundle(bundle)
    if not is_valid:
        raise ValidationError(f"Invalid skill bundle: {err}")

    installed_ids: List[str] = []
    skipped_names: List[str] = []

    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            existing_names = {s.name.lower() for s in store.skills.values() if s.status != "archived"}

            for s in bundle["skills"]:
                name = s["name"]
                if name.lower() in existing_names:
                    skipped_names.append(name)
                    continue

                skill_id = f"sk_{uuid.uuid4().hex[:12]}"
                author_type = s.get("author_type")
                if author_type not in ("person", "agent"):
                    author_type = "person" if getattr(actor, "kind", "") == "person" or (hasattr(actor, "is_person") and actor.is_person()) else "agent"
                new_skill = Skill(
                    id=skill_id,
                    workspace_id=store.workspace_id,
                    name=name,
                    description=s["description"],
                    body=s["body"],
                    tags=s.get("tags") or [],
                    status=status,
                    author_type=author_type,
                    author_id=actor.id if hasattr(actor, "id") else "system",
                    created_at=utc_now(),
                    updated_at=utc_now(),
                )
                store.skills[skill_id] = new_skill
                installed_ids.append(skill_id)
                existing_names.add(name.lower())

    return {
        "bundle_name": bundle["bundle_name"],
        "installed_count": len(installed_ids),
        "installed_ids": installed_ids,
        "skipped_count": len(skipped_names),
        "skipped_names": skipped_names,
    }
