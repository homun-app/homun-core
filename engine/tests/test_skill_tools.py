"""Tests for skills discovery, disclosure, quarantine, and proposal (H19/H20)."""
from types import SimpleNamespace
from homun.domain.models import Skill
from homun.models.native_turn import NativeMessage, ToolCall
from test_agent_runs import setup


def test_skill_search_and_progressive_view(setup):
    from homun.application.skill_tools import execute

    ctx, actor, work, _ = setup
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            s_approved = Skill(
                id="sk_approved_1",
                workspace_id=store.workspace_id,
                name="FormattaTabellaMarkdown",
                description="Linee guida per tabelle Markdown con allineamento corretto",
                body="# Guida Tabelle\nUsa sempre intestazioni e delimitatori coerenti.",
                tags=["markdown", "formattazione"],
                status="approved",
                author_type="person",
            )
            s_staged = Skill(
                id="sk_staged_2",
                workspace_id=store.workspace_id,
                name="ProceduraNonApprovata",
                description="Bozza provvisoria in quarantena",
                body="Istruzioni non verificate...",
                tags=["bozza"],
                status="staged",
                author_type="agent",
            )
            store.skills[s_approved.id] = s_approved
            store.skills[s_staged.id] = s_staged
        ctx.service.store = store

    run = {
        "id": "run_skills_1",
        "work_id": work,
        "skills": {"policy": "workspace-catalog-v1", "version": 1},
    }

    # Search: returns approved only, progressive disclosure (body omitted)
    res_search = execute(ctx, actor, run, "skill_search", {"query": "tabella"})
    assert res_search["count"] == 1
    item = res_search["skills"][0]
    assert item["id"] == "sk_approved_1"
    assert item["name"] == "FormattaTabellaMarkdown"
    assert "body" not in item  # progressive disclosure!

    # View approved skill: reveals full body
    res_view = execute(ctx, actor, run, "skill_view", {"skill_id": "sk_approved_1"})
    assert res_view["name"] == "FormattaTabellaMarkdown"
    assert "# Guida Tabelle" in res_view["body"]

    # View staged/untrusted skill: refused with typed quarantine error
    res_staged = execute(ctx, actor, run, "skill_view", {"skill_id": "sk_staged_2"})
    assert res_staged["error_code"] == "skill_untrusted"
    assert "quarantined" in res_staged["message"]

    # View unknown skill
    res_missing = execute(ctx, actor, run, "skill_view", {"skill_id": "sk_nonexistent"})
    assert res_missing["error_code"] == "skill_not_found"


def test_skill_propose_creates_staged_quarantine(setup):
    from homun.application.skill_tools import execute

    ctx, actor, work, _ = setup
    run = {
        "id": "run_skills_2",
        "work_id": work,
        "skills": {"policy": "workspace-catalog-v1", "version": 1},
    }

    res_prop = execute(ctx, actor, run, "skill_propose", {
        "name": "EstraiPrezziFornitore",
        "description": "Procedura per normalizzare listini prezzi multilinea",
        "body": "1. Leggere i file CSV o PDF\n2. Mappare colonne con alias noti",
        "tags": ["prezzi", "fornitori"],
    })

    assert res_prop["status"] == "staged"
    assert res_prop["name"] == "EstraiPrezziFornitore"
    skill_id = res_prop["skill_id"]

    # Verify skill is in store with status staged and author_type agent
    store = ctx.repository.load()
    saved = store.skills[skill_id]
    assert saved.status == "staged"
    assert saved.author_type == "agent"
    assert saved.author_id == actor.id

    # Duplicate proposal is rejected
    res_dup = execute(ctx, actor, run, "skill_propose", {
        "name": "EstraiPrezziFornitore",
        "description": "Altra descrizione",
        "body": "Altro corpo",
    })
    assert res_dup["error_code"] == "skill_already_exists"


def test_agent_run_advances_with_skill_tools(setup):
    from homun.application import agent_runs
    from homun.application.agent_run_execution import advance

    ctx, actor, work, _ = setup
    ctx.models.set_active("openai_compatible")

    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            s = Skill(
                id="sk_run_test",
                workspace_id=store.workspace_id,
                name="SintesiStandard",
                description="Regole di stile per la sintesi operativa",
                body="Usare elenchi puntati e chiara attribuzione dei compiti.",
                status="approved",
            )
            store.skills[s.id] = s
        ctx.service.store = store

    proposal = agent_runs.propose(ctx, actor, work, {
        "command_id": "run_skills_agent",
        "expected_version": 1,
        "material_ids": [],
        "skills": True,
    })
    tool_names = [t["name"] for t in proposal["tools"]]
    assert proposal["skills"] == {"policy": "workspace-catalog-v1", "version": 1}
    assert "skill_search" in tool_names
    assert "skill_view" in tool_names
    assert "skill_propose" in tool_names

    agent_runs.approve(ctx, actor, work, proposal["id"], {
        "command_id": "approve_skills_agent",
        "digest": proposal["digest"],
        "expected_version": proposal["expected_version"],
    })

    # Model completes tool call to skill_search
    ctx.models.complete_tools = lambda *a, **k: SimpleNamespace(
        message=NativeMessage(
            role="assistant",
            tool_calls=[ToolCall(id="call_sk1", name="skill_search", arguments={"query": "Sintesi"})],
        ),
        usage=None,
    )

    assert advance(ctx, proposal["id"]) == "running"
    cmd = ctx.repository.load().commands[proposal["id"]]
    obs = cmd.result["observations"][-1]
    assert obs["tool"] == "skill_search"
    assert any(sk["name"] == "SintesiStandard" for sk in obs["result"]["skills"])


def test_skill_bundle_export_and_atomic_install(setup):
    from homun.application.skill_bundle import (
        export_skill_bundle,
        validate_skill_bundle,
        install_skill_bundle,
    )

    ctx, actor, work, _ = setup

    raw_skills = [
        {
            "name": "FormattaMarkdown",
            "description": "Standard di formattazione markdown",
            "body": "Regole di formattazione...",
            "tags": ["markdown"],
        },
        {
            "name": "AuditSicurezza",
            "description": "Checklist sicurezza comandi",
            "body": "Linee guida di sicurezza...",
            "tags": ["security", "audit"],
        },
    ]

    bundle = export_skill_bundle(raw_skills, "ProductivityPack", description="Pacchetto produttività")
    assert bundle["bundle_version"] == "1.0"
    assert bundle["skills_count"] == 2
    assert bundle["checksum"]

    valid, err = validate_skill_bundle(bundle)
    assert valid is True
    assert err is None

    # Install into workspace
    res = install_skill_bundle(ctx, actor, bundle, status="staged")
    assert res["installed_count"] == 2
    assert res["skipped_count"] == 0

    store = ctx.repository.load()
    names = {s.name for s in store.skills.values()}
    assert "FormattaMarkdown" in names
    assert "AuditSicurezza" in names

    # Second install skips existing names
    res_dup = install_skill_bundle(ctx, actor, bundle, status="staged")
    assert res_dup["installed_count"] == 0
    assert res_dup["skipped_count"] == 2
