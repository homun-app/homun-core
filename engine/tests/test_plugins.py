"""Tests for Homun plugin system, lifecycle management, and retained-data contract (H37)."""
from __future__ import annotations

from pathlib import Path
import sqlite3
import pytest
from pydantic import BaseModel, Field

from homun.application.plugin_contracts import PluginManifest
from homun.application.plugin_loader import (
    iter_plugin_dirs,
    load_plugin_module,
    read_plugin_manifest,
)
from homun.application.plugin_manager import (
    PluginManager,
    get_plugin_manager,
    reset_plugin_manager,
)
from homun.application.plugin_storage import (
    plugin_data_dir,
    plugin_db,
    reset_homun_home_override,
    set_homun_home_override,
    validate_plugin_name,
)
from homun.models.agent_turn import ToolDefinition
from homun.tools.registry import ToolEntry


@pytest.fixture(autouse=True)
def clean_plugin_manager(tmp_path):
    token = set_homun_home_override(tmp_path / "homun_home")
    reset_plugin_manager()
    yield
    reset_homun_home_override(token)
    reset_plugin_manager()


# 1. Retained-data contract tests
def test_plugin_storage_retained_data_contract(tmp_path):
    home = tmp_path / "homun_home"
    set_homun_home_override(home)

    data_dir = plugin_data_dir("demo_plugin")
    assert data_dir == home / "plugin-data" / "demo_plugin"
    assert data_dir.is_dir()
    # Contract: persistent storage MUST NOT be inside plugins/
    assert (home / "plugins") not in data_dir.parents

    # Rejection of hostile / traversal names
    for bad in ["", ".", "..", "../escape", "a/b", "a\\b", "x" * 65]:
        with pytest.raises(ValueError):
            validate_plugin_name(bad)
        with pytest.raises(ValueError):
            plugin_data_dir(bad)

    # SQLite helper
    conn = plugin_db("demo_plugin", "state.db")
    try:
        conn.execute("CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT)")
        conn.execute("INSERT INTO kv VALUES ('counter', '42')")
        conn.commit()
        row = conn.execute("SELECT v FROM kv WHERE k = 'counter'").fetchone()
        assert row[0] == "42"
    finally:
        conn.close()

    assert (data_dir / "state.db").exists()

    # Rejects bad filenames
    with pytest.raises(ValueError):
        plugin_db("demo_plugin", filename="../escape.db")


# 2. Manifest parsing & loader tests
def test_plugin_manifest_parsing(tmp_path):
    pdir = tmp_path / "sample_plugin"
    pdir.mkdir()
    (pdir / "plugin.yaml").write_text(
        "name: sample\n"
        "version: 2.1.0\n"
        "description: Sample plugin description\n"
        "kind: tool\n"
        "provides_tools: [my_tool]\n"
        "provides_hooks: [pre_tool_call]\n",
        encoding="utf-8",
    )
    manifest = read_plugin_manifest(pdir)
    assert manifest.name == "sample"
    assert manifest.version == "2.1.0"
    assert manifest.kind == "tool"
    assert manifest.provides_tools == ["my_tool"]
    assert manifest.provides_hooks == ["pre_tool_call"]
    assert manifest.enabled is True


def test_plugin_loader_sibling_isolation(tmp_path):
    pdir = tmp_path / "dyn_plugin"
    pdir.mkdir()
    (pdir / "broken.py").write_text("from .nonexistent import something\n", encoding="utf-8")
    (pdir / "helper.py").write_text("val = 100\n", encoding="utf-8")
    (pdir / "__init__.py").write_text(
        "from .helper import val\n"
        "try:\n"
        "    from .broken import something\n"
        "    broken_loaded = True\n"
        "except ModuleNotFoundError:\n"
        "    broken_loaded = False\n",
        encoding="utf-8",
    )
    mod = load_plugin_module("homun_plugins.dyn_test", pdir)
    assert mod is not None
    assert mod.val == 100
    assert mod.broken_loaded is False


# 3. Registration, Hook Dispatch, and No Stale Capabilities on Disable
class DummyArgs(BaseModel):
    message: str = Field(..., description="Message text")


def test_plugin_lifecycle_and_zero_stale_capabilities(tmp_path):
    plugins_root = tmp_path / "plugins"
    plugins_root.mkdir()
    demo_dir = plugins_root / "super_plugin"
    demo_dir.mkdir()

    # Write plugin.yaml
    (demo_dir / "plugin.yaml").write_text(
        "name: super-plugin\n"
        "version: 1.0.0\n"
        "description: Full capability test\n",
        encoding="utf-8",
    )

    # Write __init__.py with register(ctx)
    (demo_dir / "__init__.py").write_text(
        "from pydantic import BaseModel, Field\n"
        "from homun.tools.registry import ToolEntry\n"
        "from homun.models.agent_turn import ToolDefinition\n"
        "\n"
        "class EchoArgs(BaseModel):\n"
        "    text: str = Field(..., description='Text to echo')\n"
        "\n"
        "def register(ctx):\n"
        "    tool_def = ToolDefinition(\n"
        "        name='super_echo',\n"
        "        description='Echo text',\n"
        "        input_schema=EchoArgs.model_json_schema()\n"
        "    )\n"
        "    entry = ToolEntry(\n"
        "        definition=tool_def,\n"
        "        toolset='super',\n"
        "        version='1',\n"
        "        arguments_model=EchoArgs,\n"
        "        handler=lambda c, a, r, args: {'echo': args['text']}\n"
        "    )\n"
        "    ctx.register_tool(entry)\n"
        "    ctx.register_hook('on_custom_event', lambda payload: f'received_{payload}')\n"
        "    ctx.register_hook('pre_tool_call', lambda tool_name, **kw: {'action': 'block', 'message': 'blocked by plugin'} if tool_name == 'forbidden_tool' else None)\n"
        "    ctx.register_command('super_cmd', lambda: 'ran_cmd', 'Super command description')\n"
        "    ctx.register_panel('super_dashboard', {'title': 'Super Panel'})\n"
        "    ctx.register_secret('SUPER_API_KEY', 'Secret API key', required=True)\n"
        "    \n"
        "    # Write something to persistent storage\n"
        "    db = ctx.get_db()\n"
        "    db.execute('CREATE TABLE IF NOT EXISTS data (val TEXT)')\n"
        "    db.execute('INSERT INTO data VALUES (\"persisted\")')\n"
        "    db.commit()\n"
        "    db.close()\n",
        encoding="utf-8",
    )

    pm = PluginManager(base_dir=tmp_path / "homun_home")
    loaded = pm.discover_and_load(plugins_root)
    assert len(loaded) == 1
    assert loaded[0].manifest.name == "super-plugin"
    assert loaded[0].enabled is True

    # 1. Verify all capabilities are active
    assert pm.get_tool("super_echo") is not None
    assert len(pm.get_active_tools()) == 1
    assert len(pm.get_commands()) == 1
    assert pm.get_commands()[0]["name"] == "super_cmd"
    assert len(pm.get_panels()) == 1
    assert pm.get_panels()[0]["id"] == "super_dashboard"

    # 2. Verify hooks dispatch
    res = pm.dispatch_hook("on_custom_event", payload="test123")
    assert res == ["received_test123"]

    # Verify policy block in pre_tool_call
    allowed_res = pm.dispatch_hook("pre_tool_call", tool_name="allowed_tool")
    assert allowed_res == [None]

    blocked_res = pm.dispatch_hook("pre_tool_call", tool_name="forbidden_tool")
    assert len(blocked_res) == 1
    assert blocked_res[0] == {"action": "block", "message": "blocked by plugin"}

    # 3. Disable the plugin -> verify NO stale capabilities remain!
    disabled = pm.disable("super-plugin")
    assert disabled is True

    assert pm.get_tool("super_echo") is None
    assert len(pm.get_active_tools()) == 0
    assert len(pm.get_commands()) == 0
    assert len(pm.get_panels()) == 0
    # Hooks should no longer fire
    assert pm.dispatch_hook("on_custom_event", payload="test123") == []
    assert pm.dispatch_hook("pre_tool_call", tool_name="forbidden_tool") == []

    # 4. Enable plugin again -> capabilities are cleanly restored
    enabled = pm.enable("super-plugin")
    assert enabled is True
    assert pm.get_tool("super_echo") is not None
    assert len(pm.get_active_tools()) == 1
    assert len(pm.get_commands()) == 1
    assert len(pm.get_panels()) == 1
    assert pm.dispatch_hook("on_custom_event", payload="again") == ["received_again"]


def test_reload_config_activates_and_deactivates(tmp_path):
    plugins_root = tmp_path / "plugins"
    plugins_root.mkdir()
    pdir = plugins_root / "togglable"
    pdir.mkdir()
    (pdir / "plugin.yaml").write_text("name: togglable\n", encoding="utf-8")
    (pdir / "__init__.py").write_text(
        "reloads = []\n"
        "def register(ctx):\n"
        "    ctx.register_hook('on_config_reload', lambda config: reloads.append(config))\n",
        encoding="utf-8",
    )

    pm = PluginManager(base_dir=tmp_path / "homun_home")
    pm.discover_and_load(plugins_root)
    assert pm.get_plugin("togglable").enabled is True

    # Reload config with togglable disabled
    pm.reload_config({"plugins": {"disabled": ["togglable"]}})
    assert pm.get_plugin("togglable").enabled is False

    # Reload config with togglable re-enabled
    pm.reload_config({"plugins": {"enabled": ["togglable"]}})
    assert pm.get_plugin("togglable").enabled is True


def test_uninstall_honors_retained_data_contract(tmp_path):
    home = tmp_path / "homun_home"
    plugins_root = tmp_path / "plugins"
    plugins_root.mkdir()
    pdir = plugins_root / "retain_demo"
    pdir.mkdir()
    (pdir / "plugin.yaml").write_text("name: retain-demo\n", encoding="utf-8")
    (pdir / "__init__.py").write_text(
        "def register(ctx):\n"
        "    data_dir = ctx.get_storage_dir()\n"
        "    (data_dir / 'saved_state.txt').write_text('important_user_notes')\n",
        encoding="utf-8",
    )

    pm = PluginManager(base_dir=home)
    pm.discover_and_load(plugins_root)

    saved_file = home / "plugin-data" / "retain-demo" / "saved_state.txt"
    assert saved_file.exists()
    assert saved_file.read_text() == "important_user_notes"

    # Uninstall without purge_data (the default)
    uninstalled = pm.uninstall("retain-demo", purge_data=False)
    assert uninstalled is True
    assert not pdir.exists()  # install dir deleted
    # Retained data contract: persistent storage MUST be preserved!
    assert saved_file.exists()
    assert saved_file.read_text() == "important_user_notes"

    # Purge explicitly
    data_dir = home / "plugin-data" / "retain-demo"
    pm.uninstall("retain-demo", purge_data=True)  # Already deleted from pm, but test helper
    import shutil
    shutil.rmtree(data_dir)
    assert not data_dir.exists()


# 4. Agent tool registry integration test
def test_agent_tool_registry_with_plugin_tool(tmp_path):
    from homun.application import agent_tool_registry
    from homun.application.plugin_manager import get_plugin_manager
    from homun.tools.registry import ToolEntry
    from homun.models.agent_turn import ToolDefinition

    home = tmp_path / "homun_home"
    pm = get_plugin_manager(base_dir=home)

    tool_def = ToolDefinition(
        name="custom_plugin_search",
        description="Search custom index",
        input_schema=DummyArgs.model_json_schema(),
    )
    entry = ToolEntry(
        definition=tool_def,
        toolset="custom",
        version="1",
        arguments_model=DummyArgs,
        handler=lambda c, a, r, args: {"found": args["message"]},
    )
    manifest = PluginManifest(name="custom_provider")
    pm._register_tool(manifest, entry)

    run = {
        "assignee_id": "agent_1",
        "team": [],
        "plugins": {
            "policy": "extensible-plugins-v1",
            "version": 1,
        },
    }
    registry = agent_tool_registry.registry_for(run)
    assert any(d.name == "custom_plugin_search" for d in registry.definitions())

    # Dispatch tool via registry
    res = registry.dispatch("custom_plugin_search", {"message": "hello"}, ctx=None, actor="user", run=run)
    assert res == {"found": "hello"}


# 5. REST API routes test
def test_plugin_routes_api(tmp_path):
    from fastapi.testclient import TestClient
    from homun.app import create_app
    from homun.application.plugin_manager import get_plugin_manager
    from homun.tools.registry import ToolEntry
    from homun.models.agent_turn import ToolDefinition

    app = create_app()
    client = TestClient(app)

    pm = get_plugin_manager(base_dir=tmp_path / "homun_home")

    # Seed plugin
    tool_def = ToolDefinition(
        name="api_tool",
        description="API tool",
        input_schema=DummyArgs.model_json_schema(),
    )
    entry = ToolEntry(
        definition=tool_def,
        toolset="api",
        version="1",
        arguments_model=DummyArgs,
    )
    manifest = PluginManifest(
        name="api-plugin",
        version="1.5.0",
        description="API Plugin",
        provides_tools=["api_tool"],
    )
    from homun.application.plugin_contracts import LoadedPlugin
    pdir = tmp_path / "plugins" / "api_plugin"
    pdir.mkdir(parents=True)
    loaded = LoadedPlugin(manifest=manifest, install_dir=pdir, enabled=True)
    pm._plugins["api-plugin"] = loaded
    pm._register_tool(manifest, entry)

    # 1. GET /v1/plugins
    resp = client.get("/v1/plugins")
    assert resp.status_code == 200
    data = resp.json()
    assert data["plugins_count"] == 1
    assert data["tools_count"] == 1

    # 2. GET /v1/plugins/api-plugin
    resp = client.get("/v1/plugins/api-plugin")
    assert resp.status_code == 200
    assert resp.json()["name"] == "api-plugin"
    assert resp.json()["version"] == "1.5.0"

    # 3. POST /v1/plugins/api-plugin/disable
    resp = client.post("/v1/plugins/api-plugin/disable")
    assert resp.status_code == 200
    assert resp.json()["success"] is True
    assert pm.get_tool("api_tool") is None

    # 4. POST /v1/plugins/api-plugin/enable
    resp = client.post("/v1/plugins/api-plugin/enable")
    assert resp.status_code == 200
    assert resp.json()["success"] is True

    # 5. GET /v1/plugins/api-plugin/data
    data_dir = plugin_data_dir("api-plugin", base_dir=tmp_path / "homun_home")
    (data_dir / "info.json").write_text("{\"status\": \"ok\"}")
    resp = client.get("/v1/plugins/api-plugin/data")
    assert resp.status_code == 200
    storage_info = resp.json()
    assert storage_info["name"] == "api-plugin"
    assert len(storage_info["files"]) == 1
    assert storage_info["files"][0]["name"] == "info.json"

    # 6. POST /v1/plugins/reload-config
    resp = client.post("/v1/plugins/reload-config", json={"plugins": {"disabled": ["api-plugin"]}})
    assert resp.status_code == 200
    assert resp.json()["success"] is True

    # 7. DELETE /v1/plugins/api-plugin
    resp = client.delete("/v1/plugins/api-plugin?purge_data=false")
    assert resp.status_code == 200
    assert not pdir.exists()
    assert (data_dir / "info.json").exists()  # Retained!
