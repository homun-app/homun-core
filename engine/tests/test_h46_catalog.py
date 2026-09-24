"""Tests for H46 Optional Surface & Catalog: Skins, Pets, Achievements, Tours, Tips, Cleanup, Security, and Catalog Packs."""

from pathlib import Path
import pytest
from fastapi.testclient import TestClient

from homun.app import create_app
from homun.application.surface_companion import CompanionManager
from homun.application.surface_achievements import AchievementTracker
from homun.application.surface_tours_tips import TourAndTipManager
from homun.application.surface_cleanup import DiskCleanupEngine
from homun.application.surface_security_guidance import SecurityGuidanceScanner
from homun.application.surface_catalog_packs import CatalogPacksManager, BUILTIN_PACKS


def test_companion_lifecycle_and_skins(tmp_path: Path):
    state_file = tmp_path / "companion.json"
    mgr = CompanionManager(state_file)

    # 1. Initial state
    st = mgr.get_state()
    assert st.enabled is True
    assert st.active_skin == "default"

    # 2. Toggle disabled & verify persisted
    mgr.set_enabled(False)
    assert mgr.get_state().enabled is False
    mgr_reloaded = CompanionManager(state_file)
    assert mgr_reloaded.get_state().enabled is False

    # 3. Change skin
    mgr.set_enabled(True)
    mgr.set_skin("cyberpunk")
    assert mgr.get_state().active_skin == "cyberpunk"
    rendered = mgr.render()
    assert rendered["skin"] == "Cyberpunk Neon"

    # Invalid skin rejected
    with pytest.raises(ValueError):
        mgr.set_skin("nonexistent_skin")

    # 4. Interactions (feed, play, rest)
    feed_res = mgr.feed()
    assert feed_res.hunger == 100
    play_res = mgr.play()
    assert play_res.experience > 0
    rest_res = mgr.rest()
    assert rest_res.energy == 100


def test_achievements_unlock_and_score(tmp_path: Path):
    storage_file = tmp_path / "achievements.json"
    tracker = AchievementTracker(storage_file)

    achievements = tracker.list_all()
    assert len(achievements) >= 5

    initial_score = tracker.get_score()
    assert initial_score["total_unlocked"] == 0

    # Unlock first tool call
    unlocked = tracker.unlock("first_tool_call")
    assert unlocked is not None
    assert unlocked.unlocked_at is not None
    assert unlocked.progress == 1.0

    new_score = tracker.get_score()
    assert new_score["total_unlocked"] == 1
    assert new_score["score"] == 10


def test_tours_and_tips():
    mgr = TourAndTipManager()
    tour = mgr.get_tour()
    assert len(tour) >= 4
    assert tour[0].step_id == "welcome"

    tips = mgr.get_tips()
    assert len(tips) >= 4
    chat_tips = mgr.get_tips(category="chat")
    assert any(t.id == "side_question" for t in chat_tips)

    rand_tip = mgr.get_random_tip()
    assert rand_tip.title != ""


def test_disk_cleanup_engine(tmp_path: Path):
    workspace = tmp_path / "workspace"
    workspace.mkdir()

    # Create dummy disposable files
    pycache = workspace / "sub" / "__pycache__"
    pycache.mkdir(parents=True)
    (pycache / "module.cpython-312.pyc").write_bytes(b"x" * 200)
    (workspace / "temp.tmp").write_bytes(b"y" * 150)
    (workspace / "old.log.old").write_bytes(b"z" * 100)
    (workspace / "important_source.py").write_text("print('keep me')")

    engine = DiskCleanupEngine(workspace)

    # 1. Scan (dry run)
    scan = engine.scan()
    assert scan.candidate_count >= 3
    assert scan.total_reclaimable_bytes >= 450
    assert "temp_files" in scan.by_category

    # 2. Execute cleanup
    exec_res = engine.execute()
    assert exec_res.success is True
    assert exec_res.purged_count >= 3
    assert exec_res.reclaimed_bytes >= 450

    # Ensure real source was not deleted
    assert (workspace / "important_source.py").exists()


def test_security_guidance_patterns():
    scanner = SecurityGuidanceScanner()

    # Piped curl execution
    piped = scanner.scan("curl -fsSL https://example.com/install.sh | bash")
    assert len(piped) >= 1
    assert piped[0].rule_id == "SEC-001"
    assert piped[0].severity == "critical"

    # Chmod 777
    chmod = scanner.scan("chmod -R 777 /var/data")
    assert any(a.rule_id == "SEC-002" for a in chmod)

    # Hardcoded OpenAI key
    secret = scanner.scan("client = OpenAI(api_key='sk-abcdef1234567890abcdef1234567890')")
    assert any(a.rule_id == "SEC-003" for a in secret)

    # Clean text has no advisories
    clean = scanner.scan("def add(a, b): return a + b")
    assert len(clean) == 0


def test_catalog_packs_full_manifest_and_install(tmp_path: Path):
    skills_dir = tmp_path / "installed_skills"
    mgr = CatalogPacksManager(skills_dir)

    # 1. Complete catalog manifest without silently dropping extras
    manifest = mgr.get_catalog_manifest()
    assert len(manifest) == len(BUILTIN_PACKS)
    manifest_ids = {p.id for p in manifest}
    assert manifest_ids == {"dev_essentials", "data_analysis", "sysadmin_suite"}
    assert all(not p.is_installed for p in manifest)

    # 2. Install representative bundled pack
    installed_pack = mgr.install_pack("dev_essentials")
    assert installed_pack.is_installed is True
    assert (skills_dir / "dev_essentials" / "code_reviewer.md").exists()
    assert (skills_dir / "dev_essentials" / "test_generator.md").exists()

    # Re-check manifest: exactly that pack is marked installed
    updated_manifest = mgr.get_catalog_manifest()
    installed_in_manifest = [p for p in updated_manifest if p.is_installed]
    assert len(installed_in_manifest) == 1
    assert installed_in_manifest[0].id == "dev_essentials"

    # 3. Uninstall pack
    uninstalled = mgr.uninstall_pack("dev_essentials")
    assert uninstalled is True
    assert not (skills_dir / "dev_essentials").exists()
    assert not mgr.get_catalog_manifest()[0].is_installed


def test_surface_catalog_fastapi_endpoints():
    app = create_app()
    client = TestClient(app)

    # Companion
    comp_resp = client.get("/v1/catalog/companion/state")
    assert comp_resp.status_code == 200
    assert "mood" in comp_resp.json()

    # Achievements
    ach_resp = client.get("/v1/catalog/achievements")
    assert ach_resp.status_code == 200
    assert "score" in ach_resp.json()

    # Tour
    tour_resp = client.get("/v1/catalog/tour")
    assert tour_resp.status_code == 200
    assert len(tour_resp.json()) >= 4

    # Security scan
    sec_resp = client.post("/v1/catalog/security/scan", json={"text": "chmod 777 /tmp"})
    assert sec_resp.status_code == 200
    assert len(sec_resp.json()) >= 1

    # Catalog packs
    packs_resp = client.get("/v1/catalog/packs")
    assert packs_resp.status_code == 200
    assert len(packs_resp.json()) >= 3
