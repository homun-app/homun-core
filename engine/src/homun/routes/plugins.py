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


@router.post("/{name}/enable", response_model=PluginActionResponse)
def enable_plugin(name: str) -> PluginActionResponse:
    """Enable a disabled plugin and re-register its capabilities."""
    pm = get_plugin_manager()
    success = pm.enable(name)
    if not success:
        raise HTTPException(status_code=400, detail=f"Failed to enable plugin '{name}'")
    return PluginActionResponse(success=True, name=name, message=f"Plugin '{name}' enabled successfully")


@router.post("/{name}/disable", response_model=PluginActionResponse)
def disable_plugin(name: str) -> PluginActionResponse:
    """Disable a plugin and release all registered capabilities without stale remnants."""
    pm = get_plugin_manager()
    success = pm.disable(name)
    if not success:
        raise HTTPException(status_code=404, detail=f"Plugin '{name}' not found")
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
