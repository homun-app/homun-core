"""REST API routes for plugin discovery, lifecycle management, and retained data."""
from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from homun.application.plugin_manager import get_plugin_manager
from homun.application.plugin_storage import plugin_data_dir

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1/plugins", tags=["plugins"])


class PluginActionResponse(BaseModel):
    success: bool
    name: str
    message: str


class PluginStorageFile(BaseModel):
    name: str
    size_bytes: int


class PluginStorageInfoResponse(BaseModel):
    name: str
    storage_path: str
    files: List[PluginStorageFile]
    total_size_bytes: int


class PluginConfigReloadRequest(BaseModel):
    plugins: Dict[str, Any] = Field(default_factory=dict)


@router.get("", response_model=Dict[str, Any])
def list_plugins() -> Dict[str, Any]:
    """List loaded plugins, manifests, active capabilities and summary."""
    pm = get_plugin_manager()
    return pm.summary()


@router.get("/{name}", response_model=Dict[str, Any])
def get_plugin_detail(name: str) -> Dict[str, Any]:
    """Retrieve details for a specific plugin."""
    pm = get_plugin_manager()
    plugin = pm.get_plugin(name)
    if not plugin:
        raise HTTPException(status_code=404, detail=f"Plugin '{name}' not found")
    
    return {
        "name": plugin.manifest.name,
        "version": plugin.manifest.version,
        "description": plugin.manifest.description,
        "author": plugin.manifest.author,
        "kind": plugin.manifest.kind,
        "enabled": plugin.enabled,
        "error": plugin.error,
        "provides_tools": plugin.manifest.provides_tools,
        "provides_hooks": plugin.manifest.provides_hooks,
        "provides_panels": plugin.manifest.provides_panels,
        "provides_commands": plugin.manifest.provides_commands,
        "provides_skills": plugin.manifest.provides_skills,
        "requires_env": plugin.manifest.requires_env,
        "config_schema": plugin.manifest.config_schema,
    }


def _persist_enabled(name: str, enabled: bool) -> None:
    from homun.application.plugin_storage import load_plugins_config, save_plugins_config
    config = load_plugins_config()
    plugins = config.setdefault("plugins", {})
    disabled = set(plugins.get("disabled", []))
    disabled.discard(name) if enabled else disabled.add(name)
    plugins["disabled"] = sorted(disabled)
    save_plugins_config(config)


@router.post("/{name}/enable", response_model=PluginActionResponse)
def enable_plugin(name: str) -> PluginActionResponse:
    """Enable a disabled plugin and re-register its capabilities."""
    pm = get_plugin_manager()
    success = pm.enable(name)
    if not success:
        raise HTTPException(status_code=400, detail=f"Failed to enable plugin '{name}'")
    _persist_enabled(name, True)
    return PluginActionResponse(success=True, name=name, message=f"Plugin '{name}' enabled successfully")


@router.post("/{name}/disable", response_model=PluginActionResponse)
def disable_plugin(name: str) -> PluginActionResponse:
    """Disable a plugin and release all registered capabilities without stale remnants."""
    pm = get_plugin_manager()
    success = pm.disable(name)
    if not success:
        raise HTTPException(status_code=404, detail=f"Plugin '{name}' not found")
    _persist_enabled(name, False)
    return PluginActionResponse(success=True, name=name, message=f"Plugin '{name}' disabled successfully")


@router.delete("/{name}", response_model=PluginActionResponse)
def uninstall_plugin(
    name: str,
    purge_data: bool = Query(default=False, description="Whether to purge persistent data (default: False)")
) -> PluginActionResponse:
    """Uninstall a plugin, deleting its install tree while honoring retained data."""
    pm = get_plugin_manager()
    success = pm.uninstall(name, purge_data=purge_data)
    if not success:
        raise HTTPException(status_code=404, detail=f"Plugin '{name}' not found")
    msg = f"Plugin '{name}' uninstalled (data {'purged' if purge_data else 'retained'})"
    return PluginActionResponse(success=True, name=name, message=msg)


@router.get("/{name}/data", response_model=PluginStorageInfoResponse)
def get_plugin_storage(name: str) -> PluginStorageInfoResponse:
    """Inspect retained storage directory and files for a plugin."""
    try:
        data_dir = plugin_data_dir(name)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    
    files = []
    total_size = 0
    if data_dir.exists():
        for path in sorted(data_dir.rglob("*")):
            if path.is_file():
                sz = path.stat().st_size
                files.append(PluginStorageFile(name=path.relative_to(data_dir).as_posix(), size_bytes=sz))
                total_size += sz

    return PluginStorageInfoResponse(
        name=name,
        storage_path=str(data_dir),
        files=files,
        total_size_bytes=total_size,
    )


@router.post("/reload-config", response_model=Dict[str, Any])
def reload_plugin_config(req: PluginConfigReloadRequest) -> Dict[str, Any]:
    """Apply updated configuration across all plugins."""
    pm = get_plugin_manager()
    pm.reload_config({"plugins": req.plugins})
    return {"success": True, "summary": pm.summary()}

class PluginInstallRequest(BaseModel):
    repo: str = Field(min_length=8, max_length=500)
    sha: str = Field(min_length=40, max_length=40, pattern=r"^[0-9a-f]{40}$")
    name: Optional[str] = Field(default=None, max_length=64)


@router.post("/install", response_model=Dict[str, Any])
def install_plugin(body: PluginInstallRequest) -> Dict[str, Any]:
    """Install a plugin from git at an EXACT commit SHA (the Hermes trust model:
    no branches, no tags, no self-updating code — the pin is the review).

    Clones without checkout, verifies the SHA exists, validates the manifest,
    then moves the tree into the install root and loads it.
    """
    import re
    import shutil
    import subprocess
    import tempfile
    from pathlib import Path

    from homun.application.plugin_loader import read_plugin_manifest
    from homun.application.plugin_manager import get_plugin_manager, logger as pm_logger
    from homun.application.plugin_storage import plugins_root, save_plugins_config, load_plugins_config

    if not re.fullmatch(r"[0-9a-f]{40}", body.sha):
        raise HTTPException(status_code=400, detail={
            "code": "invalid_sha", "message": "Serve uno SHA esatto di 40 caratteri: niente branch, niente tag."})
    if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}", body.name or "") and body.name:
        raise HTTPException(status_code=400, detail={
            "code": "invalid_name", "message": "Nome plugin non valido."})

    with tempfile.TemporaryDirectory(prefix="homun-plugin-install-") as tmp:
        work = Path(tmp) / "repo"
        try:
            subprocess.run(["git", "clone", "--quiet", "--no-checkout", body.repo, str(work)],
                           check=True, timeout=180, capture_output=True)
            checkout = subprocess.run(["git", "-C", str(work), "checkout", "--quiet", body.sha],
                                      capture_output=True, text=True, timeout=60)
        except subprocess.TimeoutExpired:
            raise HTTPException(status_code=504, detail={
                "code": "install_timeout", "message": "Clone o checkout fuori tempo."})
        except subprocess.CalledProcessError as exc:
            raise HTTPException(status_code=400, detail={
                "code": "install_failed",
                "message": f"Clone fallito: {(exc.stderr or '')[:200]}"})
        if checkout.returncode != 0:
            raise HTTPException(status_code=400, detail={
                "code": "sha_not_found",
                "message": f"Lo SHA {body.sha[:12]}… non esiste nel repository."})

        try:
            manifest = read_plugin_manifest(work)
        except Exception as exc:
            raise HTTPException(status_code=400, detail={
                "code": "invalid_manifest", "message": f"Manifest non valido: {exc}"})
        name = body.name or manifest.name
        if name != manifest.name:
            raise HTTPException(status_code=400, detail={
                "code": "name_mismatch",
                "message": f"Il manifest dichiara '{manifest.name}', non '{name}'."})

        target = plugins_root() / name
        if target.exists():
            raise HTTPException(status_code=409, detail={
                "code": "already_installed", "message": f"Plugin già installato: {name}"})
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(work), str(target))

    loaded = get_plugin_manager().load_from_directory(target, config=load_plugins_config())
    if loaded.error:
        pm_logger.warning("plugin %s installed but failed to load: %s", name, loaded.error)
    return {"name": name, "version": manifest.version, "loaded": loaded.error is None,
            "error": loaded.error}

