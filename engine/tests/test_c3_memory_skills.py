"""Tests for C3: Progressive skill resources, trust approval, hub curation, and background memory review."""
from types import SimpleNamespace
import pytest

from homun.domain.models import Actor, Skill
from homun.domain.errors import ConflictError
from test_agent_runs import setup


def test_progressive_skill_resources(setup):
    from homun.application.skill_tools import execute

    ctx, actor, work, _ = setup
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            s_approved = Skill(
                id="sk_approved_res",
                workspace_id=store.workspace_id,
                name="DataPipelineSkill",
                description="Pipeline automation guidelines and scripts",
                body="# Data Pipeline\nFollow strict ETL phases.",
                tags=["data", "etl"],
                resources={
                    "scripts/validate.py": "def validate(): return True",
                    "templates/config.yaml": "version: 1\nenv: prod\n",
                    "references/guide.md": "# ETL Guide\nDetails...",
                },
                status="approved",
                author_type="person",
            )
            s_staged = Skill(
                id="sk_staged_res",
                workspace_id=store.workspace_id,
                name="UntrustedSkill",
                description="Staged pipeline",
                body="Draft...",
                resources={"scripts/run.py": "print('hello')"},
                status="staged",
                author_type="agent",
            )
            store.skills[s_approved.id] = s_approved
            store.skills[s_staged.id] = s_staged
        ctx.service.store = store

    run = {
        "id": "run_skills_res",
        "work_id": work,
        "skills": {"policy": "workspace-catalog-v1", "version": 1},
    }

    # 1. skill_view lists resource names progressively without full contents
    res_view = execute(ctx, actor, run, "skill_view", {"skill_id": "sk_approved_res"})
    assert res_view["name"] == "DataPipelineSkill"
    assert "resources" in res_view
    assert res_view["resources"] == ["references/guide.md", "scripts/validate.py", "templates/config.yaml"]
    assert "def validate()" not in str(res_view)

    # 2. skill_resource retrieves exact resource
    res_script = execute(ctx, actor, run, "skill_resource", {
        "skill_id": "sk_approved_res",
        "resource_path": "scripts/validate.py",
    })
    assert res_script["skill_id"] == "sk_approved_res"
    assert res_script["resource_path"] == "scripts/validate.py"
    assert "def validate(): return True" in res_script["content"]

    # 3. skill_resource by skill name
    res_yaml = execute(ctx, actor, run, "skill_resource", {
        "name": "DataPipelineSkill",
        "resource_path": "templates/config.yaml",
    })
    assert "version: 1" in res_yaml["content"]

    # 4. Path traversal attempt rejected
    res_traversal = execute(ctx, actor, run, "skill_resource", {
        "skill_id": "sk_approved_res",
        "resource_path": "../../../etc/passwd",
    })
    assert res_traversal["error_code"] == "invalid_resource_path"

    res_traversal_abs = execute(ctx, actor, run, "skill_resource", {
        "skill_id": "sk_approved_res",
        "resource_path": "/etc/shadow",
    })
    assert res_traversal_abs["error_code"] == "invalid_resource_path"

    # 5. Missing resource returns resource_not_found
    res_missing = execute(ctx, actor, run, "skill_resource", {
        "skill_id": "sk_approved_res",
        "resource_path": "scripts/unknown.py",
    })
    assert res_missing["error_code"] == "resource_not_found"

    # 6. Untrusted / staged skill refuses resource retrieval
    res_untrusted = execute(ctx, actor, run, "skill_resource", {
        "skill_id": "sk_staged_res",
        "resource_path": "scripts/run.py",
    })
    assert res_untrusted["error_code"] == "skill_untrusted"


def test_skill_trust_and_human_approval(setup):
    from homun.application.skill_tools import execute

    ctx, human_actor, work, _ = setup
    agent_actor = Actor(id="agent_worker_1", workspace_id=human_actor.workspace_id, display_name="Agent", kind="agent")

    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            s_staged = Skill(
                id="sk_to_trust",
                workspace_id=store.workspace_id,
                name="SecurityScanProcedure",
                description="Procedura per l'analisi delle dipendenze",
                body="Eseguire pip audit prima della release.",
                status="staged",
                author_type="agent",
                revision=1,
            )
            store.skills[s_staged.id] = s_staged
        ctx.service.store = store

    run = {
        "id": "run_trust_test",
        "work_id": work,
        "skills": {"policy": "workspace-catalog-v1", "version": 1},
    }

    # 1. Agent calling skill_trust without human approval is denied with ConflictError
    with pytest.raises(ConflictError) as exc_info:
        execute(ctx, agent_actor, run, "skill_trust", {"skill_id": "sk_to_trust", "approved": True})
    assert "requires explicit human approval" in str(exc_info.value)

    # 2. Version mismatch with expected_version raises ConflictError
    with pytest.raises(ConflictError) as exc_info_ver:
        execute(ctx, agent_actor, run, "skill_trust", {
            "skill_id": "sk_to_trust",
            "approved": True,
            "expected_version": 99,
            "approval_token": "token_approved_by_user",
        })
    assert "mismatch" in str(exc_info_ver.value)

    # 3. Agent calling with approval_token succeeds
    res_agent_approved = execute(ctx, agent_actor, run, "skill_trust", {
        "skill_id": "sk_to_trust",
        "approved": True,
        "expected_version": 1,
        "approval_token": "token_approved_by_user",
    })
    assert res_agent_approved["status"] == "approved"
    assert res_agent_approved["revision"] == 2

    # Verify updated in repository
    store = ctx.repository.load()
    assert store.skills["sk_to_trust"].status == "approved"
    assert store.skills["sk_to_trust"].revision == 2

    # 4. Human actor can change trust directly
    res_archive = execute(ctx, human_actor, run, "skill_trust", {
        "skill_id": "sk_to_trust",
        "approved": False,
        "expected_version": 2,
    })
    assert res_archive["status"] == "archived"
    assert res_archive["revision"] == 3


def test_hub_curation_and_bundle_lifecycle(setup):
    from homun.application.skill_bundle import (
        curate_skill_bundle,
        validate_skill_bundle,
        install_skill_bundle,
        uninstall_skill_bundle,
    )

    ctx, actor, work, _ = setup

    skills_data = [
        {
            "name": "HubPythonLinter",
            "description": "Standard Python linting rules",
            "body": "Use ruff and flake8.",
            "tags": ["python", "linting"],
            "resources": {
                "ruff.toml": "line-length = 100",
                "rules.md": "# Linting Guidelines",
            },
        },
        {
            "name": "HubDockerGuidelines",
            "description": "Multi-stage Dockerfile best practices",
            "body": "Use minimal distroless base images.",
            "tags": ["docker", "devops"],
            "resources": {
                "Dockerfile.sample": "FROM python:3.13-slim\n",
            },
        },
    ]

    # 1. Hub curation packaging
    curated_bundle = curate_skill_bundle(
        skills_data,
        "DevOpsHubPack",
        description="Official DevOps and linting skills",
        author="Homun Foundation",
        category="devops",
        license="Apache-2.0",
        min_engine_version="2.0",
    )
    assert curated_bundle["bundle_name"] == "DevOpsHubPack"
    assert curated_bundle["hub_curation"]["curated"] is True
    assert curated_bundle["hub_curation"]["category"] == "devops"
    assert curated_bundle["hub_curation"]["license"] == "Apache-2.0"
    assert curated_bundle["checksum"]

    # 2. Validate bundle
    is_valid, err = validate_skill_bundle(curated_bundle)
    assert is_valid is True
    assert err is None

    # 3. Install bundle into workspace
    res_inst = install_skill_bundle(ctx, actor, curated_bundle, status="approved")
    assert res_inst["installed_count"] == 2
    assert res_inst["bundle_name"] == "DevOpsHubPack"

    store = ctx.repository.load()
    installed = [s for s in store.skills.values() if "bundle:devopshubpack" in [t.lower() for t in s.tags]]
    assert len(installed) == 2
    py_skill = next(s for s in installed if s.name == "HubPythonLinter")
    assert py_skill.resources["ruff.toml"] == "line-length = 100"

    # 4. Uninstall bundle: archives all installed skills
    res_uninst = uninstall_skill_bundle(ctx, actor, "DevOpsHubPack")
    assert res_uninst["uninstalled_count"] == 2

    store_after = ctx.repository.load()
    for s_id in res_uninst["uninstalled_ids"]:
        assert store_after.skills[s_id].status == "archived"


def test_background_memory_review_and_prune(setup):
    from homun.application.memory_tools import execute

    ctx, actor, work, _ = setup

    # Populate memories with duplicates and distinct notes
    ctx.memory.add_approved(
        text="Il team preferisce usare PostgreSQL come database principale per i microservizi",
        actor_id=actor.id,
        work_id=work,
        project_id="proj_alpha",
    )
    # Duplicate with minor variance
    ctx.memory.add_approved(
        text="Il team preferisce usare PostgreSQL come database principale per tutti i microservizi",
        actor_id=actor.id,
        work_id=work,
        project_id="proj_alpha",
    )
    # Exact duplicate
    ctx.memory.add_approved(
        text="Il team preferisce usare PostgreSQL come database principale per i microservizi",
        actor_id=actor.id,
        work_id=work,
        project_id="proj_alpha",
    )
    # Distinct note
    ctx.memory.add_approved(
        text="Le riunioni di allineamento si tengono ogni lunedì mattina alle 9:30",
        actor_id=actor.id,
        work_id=work,
        project_id="proj_alpha",
    )

    run = {
        "id": "run_mem_review",
        "work_id": work,
        "memory": {"policy": "scoped-workspace-v1", "version": 1},
    }

    # 1. Preview mode: finds duplicate clusters without deleting anything
    res_preview = execute(ctx, actor, run, "memory_review", {
        "project_id": "proj_alpha",
        "min_similarity": 0.8,
        "action": "preview",
    })
    assert res_preview["status"] == "preview"
    assert res_preview["total_reviewed"] == 4
    assert res_preview["duplicate_clusters"] == 1
    cluster = res_preview["candidates"][0]
    assert len(cluster["redundant_notes"]) == 2

    # Check store still has 4 active notes
    assert len(ctx.memory.list(project_id="proj_alpha", include_deleted=False)) == 4

    # 2. Prune mode: cleans up redundant notes, keeps canonical note
    res_prune = execute(ctx, actor, run, "memory_review", {
        "project_id": "proj_alpha",
        "min_similarity": 0.8,
        "action": "prune",
    })
    assert res_prune["status"] == "pruned"
    assert res_prune["pruned_count"] == 2
    assert len(res_prune["pruned_ids"]) == 2

    # Now only 2 active notes remain in project_id="proj_alpha"
    active_notes = ctx.memory.list(project_id="proj_alpha", include_deleted=False)
    assert len(active_notes) == 2
    texts = [n.text for n in active_notes]
    assert any("PostgreSQL" in t for t in texts)
    assert any("riunioni" in t for t in texts)
