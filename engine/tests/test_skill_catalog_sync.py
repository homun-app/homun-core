"""Catalog repository sync: create, update pristine, keep human edits."""
from __future__ import annotations

import json

import pytest

from homun.context import create_context
from homun.domain.models import Actor


@pytest.fixture
def ctx(tmp_path):
    ctx = create_context(db_path=tmp_path / 'engine.db', data_dir=tmp_path, for_tests=True)
    yield ctx
    ctx.close()


def _apply(ctx, actor, command_id, kind, payload):
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            result = ctx.service.for_store(store).apply(actor, command_id, kind, payload)
        ctx.service.store = store
    return result


def _repo(tmp_path, bodies, resources=None) -> str:
    """Minimal catalog repo: one skill 'alpha' with configurable body."""
    root = tmp_path / "catalog"
    skill = root / "internal" / "alpha"
    (skill / "references").mkdir(parents=True)
    (skill / "SKILL.md").write_text(
        "---\nname: alpha\ndescription: Metodo alpha\n---\n\n" + bodies[0], encoding="utf-8")
    if resources:
        (skill / "references" / "table.md").write_text(resources[0], encoding="utf-8")
    (root / "manifest.json").write_text(json.dumps({
        "catalog_version": 1, "skills": [
            {"name": "alpha", "category": "internal", "path": "internal/alpha",
             "files": ["SKILL.md"]}]}), encoding="utf-8")
    return str(root)


def test_sync_creates_updates_and_respects_human_edits(ctx, tmp_path):
    from homun.application.skill_catalog_sync import sync_skill_catalog
    actor = Actor(id='person_owner', workspace_id=ctx.workspace_id, display_name='Owner')

    repo_v1 = _repo(tmp_path, ["Regola uno."], resources=["Tabella A|B"])
    first = sync_skill_catalog(ctx, repo_v1)
    assert first["created"] == ["alpha"] and not first["errors"]
    store = ctx.repository.load()
    skill = next(s for s in store.skills.values() if s.name == "alpha")
    assert skill.status == "approved" and skill.author_id == "homun:builtin"
    assert skill.resources == {"references/table.md": "Tabella A|B"}

    # Second sync with identical content: nothing to do.
    again = sync_skill_catalog(ctx, repo_v1)
    assert again["created"] == [] and again["updated"] == []

    # Repo evolves: pristine builtin is updated.
    repo_v2 = _repo(tmp_path / "v2", ["Regola uno.\nRegola due."], resources=["Tabella A|B|C"])
    second = sync_skill_catalog(ctx, repo_v2)
    assert second["updated"] == ["alpha"]
    store = ctx.repository.load()
    skill = next(s for s in store.skills.values() if s.name == "alpha")
    assert "Regola due." in skill.body
    assert skill.resources == {"references/table.md": "Tabella A|B|C"}
    assert skill.revision == 2

    # A human edit wins: after it, the same repo sync keeps the human version.
    _apply(ctx, actor, 'human-patch', 'skill.patch', {
        "skill_id": skill.id, "expected_version": skill.revision,
        "body": "Regola umana, non toccare."})
    third = sync_skill_catalog(ctx, repo_v2)
    assert third["kept_human"] == ["alpha"] and third["updated"] == []
    store = ctx.repository.load()
    skill = next(s for s in store.skills.values() if s.name == "alpha")
    assert skill.body == "Regola umana, non toccare."


def test_sync_skips_oversized_and_binary_resources(ctx, tmp_path):
    from homun.application.skill_catalog_sync import sync_skill_catalog
    root = tmp_path / "catalog-big"
    skill = root / "internal" / "beta"
    (skill / "scripts").mkdir(parents=True)
    (skill / "SKILL.md").write_text(
        "---\nname: beta\ndescription: Beta\n---\n\nCorpo.", encoding="utf-8")
    (skill / "scripts" / "run.py").write_text("print('ok')\n", encoding="utf-8")
    (skill / "scripts" / "big.bin").write_bytes(b"\x00" * 128)
    (root / "manifest.json").write_text(json.dumps({
        "skills": [{"name": "beta", "path": "internal/beta"}]}), encoding="utf-8")
    report = sync_skill_catalog(ctx, str(root))
    assert report["created"] == ["beta"]
    store = ctx.repository.load()
    created = next(s for s in store.skills.values() if s.name == "beta")
    assert created.resources == {"scripts/run.py": "print('ok')\n"}
    assert any("big.bin" in note for note in report["resource_notes"])


def test_sync_skips_external_only_and_archives_absent_pristine(ctx, tmp_path):
    from homun.application.skill_catalog_sync import sync_skill_catalog
    root = tmp_path / "catalog-h"
    for name in ("gamma", "delta"):
        skill = root / "internal" / name
        skill.mkdir(parents=True)
        (skill / "SKILL.md").write_text(
            f"---\nname: {name}\ndescription: {name}\n---\n\nCorpo {name}.", encoding="utf-8")
    (root / "manifest.json").write_text(json.dumps({"skills": [
        {"name": "gamma", "path": "internal/gamma"},
        {"name": "delta", "path": "internal/delta", "external_only": True}]}), encoding="utf-8")
    first = sync_skill_catalog(ctx, str(root))
    assert first["created"] == ["gamma"]
    assert first["external_only"] == ["delta"]
    store = ctx.repository.load()
    assert not any(s.name == "delta" for s in store.skills.values())  # external-only: mai seeded

    # Una external-only gia' presente e pristine viene archiviata dal sync.
    from homun.domain.models import Actor
    actor = Actor(id='person_owner', workspace_id=ctx.workspace_id, display_name='Owner')
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            ctx.service.for_store(store).apply(
                actor, 'ho-create', 'skill.create',
                {"name": "delta", "description": "d", "body": "x", "author_type": "person",
                 "author_id": "homun:builtin", "status": "approved"})
        ctx.service.store = store

    # Il catalogo v2 rimuove gamma: la builtin intatta viene archiviata.
    (root / "internal" / "gamma" / "SKILL.md").unlink()
    (root / "internal" / "gamma").rmdir()
    (root / "manifest.json").write_text(json.dumps({"skills": [
        {"name": "delta", "path": "internal/delta", "external_only": True}]}), encoding="utf-8")
    second = sync_skill_catalog(ctx, str(root))
    assert sorted(second["archived_absent"]) == ["delta", "gamma"]
    store = ctx.repository.load()
    gamma = next(s for s in store.skills.values() if s.name == "gamma")
    assert gamma.status == "archived"


def test_rebase_recovers_machine_drift_but_never_human_edits(ctx, tmp_path):
    from homun.application.skill_catalog_sync import sync_skill_catalog
    from homun.domain.models import Actor
    actor = Actor(id='person_owner', workspace_id=ctx.workspace_id, display_name='Owner')

    versions = iter(range(100))

    def repo(body):
        root = tmp_path / f"cat-{next(versions)}"
        skill = root / "internal" / "epsilon"
        skill.mkdir(parents=True)
        (skill / "SKILL.md").write_text(
            f"---\nname: epsilon\ndescription: e\n---\n\n{body}", encoding="utf-8")
        (root / "manifest.json").write_text(json.dumps(
            {"skills": [{"name": "epsilon", "path": "internal/epsilon"}]}), encoding="utf-8")
        return str(root)

    sync_skill_catalog(ctx, repo("V1."))                      # create, state=V1
    # Drift macchina: una patch fatta con un comando del catalogo (simulata
    # dal tool stesso) senza aggiornare lo stato.
    store = ctx.repository.load()
    sk = next(s for s in store.skills.values() if s.name == "epsilon")
    with ctx.repository.locked():
        with ctx.repository.transaction() as w:
            ctx.service.for_store(w).apply(actor, "catalog-sync:epsilon:manual:p",
                                           "skill.patch", {"skill_id": sk.id,
                                                           "expected_version": sk.revision,
                                                           "body": "V1. drift macchina."})
        ctx.service.store = w
    plain = sync_skill_catalog(ctx, repo("V2."))
    assert plain["kept_human"] == ["epsilon"]                 # senza rebase resta protetta
    rebased = sync_skill_catalog(ctx, repo("V2."), rebase=True)
    assert rebased["updated"] == ["epsilon"]                  # drift solo-macchina: ribasata
    sk = next(s for s in ctx.repository.load().skills.values() if s.name == "epsilon")
    assert "V2." in sk.body

    # Dopo una modifica umana il rebase non puo' piu' intervenire.
    with ctx.repository.locked():
        with ctx.repository.transaction() as w:
            ctx.service.for_store(w).apply(actor, "human-edit", "skill.patch",
                                           {"skill_id": sk.id, "expected_version": sk.revision,
                                            "body": "Versione umana."})
        ctx.service.store = w
    final = sync_skill_catalog(ctx, repo("V3."), rebase=True)
    assert final["kept_human"] == ["epsilon"]
    sk = next(s for s in ctx.repository.load().skills.values() if s.name == "epsilon")
    assert sk.body == "Versione umana."
