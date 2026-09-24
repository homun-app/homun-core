"""Contracts for plugin manifests, registration handles, context, and metadata."""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
import sqlite3
from typing import Any, Callable, Dict, List, Optional
from pydantic import BaseModel, Field

from homun.application.plugin_storage import plugin_data_dir, plugin_db
from homun.tools.registry import ToolEntry


class PluginManifest(BaseModel):
    """Specification of a Homun plugin declared via plugin.yaml or plugin.json."""
    name: str = Field(..., description="Unique plugin identifier name")
    version: str = Field(default="1.0.0", description="Semantic version string")
    description: str = Field(default="", description="Human-readable description")
    author: str = Field(default="", description="Plugin author or maintainer")
    kind: str = Field(default="standalone", description="Plugin category or type")
    provides_tools: List[str] = Field(default_factory=list, description="Tool names supplied")
    provides_hooks: List[str] = Field(default_factory=list, description="Hook names subscribed")
    provides_panels: List[str] = Field(default_factory=list, description="UI panel IDs provided")
    provides_commands: List[str] = Field(default_factory=list, description="CLI / chat commands")
    provides_skills: List[str] = Field(default_factory=list, description="Skills provided")
    provides_providers: List[str] = Field(default_factory=list, description="Providers supplied")
    requires_env: List[str] = Field(default_factory=list, description="Required environment variables")
    config_schema: Dict[str, Any] = Field(default_factory=dict, description="Configuration schema")
    enabled: bool = Field(default=True, description="Whether this plugin is enabled by default")


@dataclass
class PluginRegistration:
    """A managed registration handle paired with its reverse release action.

    Calling dispose() releases the capability and prevents stale remnants.
    """
    kind: str
    key: str
    release: Callable[[], None]
    plugin_key: str = ""
    persistent: bool = False
    _disposed: bool = field(default=False, init=False, repr=False)

    @property
    def active(self) -> bool:
        return not self._disposed

    def dispose(self) -> None:
        if self._disposed:
            return
        self._disposed = True
        try:
            self.release()
        except Exception:
            pass


@dataclass
class LoadedPlugin:
    """Runtime representation of a discovered or loaded plugin."""
    manifest: PluginManifest
    install_dir: Optional[Path] = None
    module: Any = None
    enabled: bool = True
    error: Optional[str] = None


class PluginContext:
    """API passed to a plugin's register(ctx) function to bind capabilities.

    Every registration creates a disposable handle recorded in the manager's ledger.
    """
    def __init__(
        self,
        name: str,
        manifest: PluginManifest,
        manager: Any,
        config: Optional[Dict[str, Any]] = None,
        base_dir: Optional[Path] = None,
    ) -> None:
        self.name = name
        self.manifest = manifest
        self._manager = manager
        self.config = config or {}
        self._base_dir = base_dir

    def register_tool(self, entry: ToolEntry) -> PluginRegistration:
        """Register an execution tool."""
        return self._manager._register_tool(self.manifest, entry)

    def register_hook(self, hook_name: str, callback: Callable) -> PluginRegistration:
        """Register a lifecycle or event hook callback."""
        return self._manager._register_hook(self.manifest, hook_name, callback)

    def register_provider(self, kind: str, name: str, provider: Any) -> PluginRegistration:
        """Register a backend or service provider."""
        return self._manager._register_provider(self.manifest, kind, name, provider)

    def register_platform(self, name: str, adapter: Any) -> PluginRegistration:
        """Register an integration platform adapter."""
        return self._manager._register_platform(self.manifest, name, adapter)

    def register_command(self, name: str, handler: Callable, description: str = "") -> PluginRegistration:
        """Register a user or CLI command."""
        return self._manager._register_command(self.manifest, name, handler, description)

    def register_skill(self, name: str, spec: Dict[str, Any]) -> PluginRegistration:
        """Register an agent skill package."""
        return self._manager._register_skill(self.manifest, name, spec)

    def register_panel(self, panel_id: str, panel_spec: Dict[str, Any]) -> PluginRegistration:
        """Register a UI feature panel or dashboard."""
        return self._manager._register_panel(self.manifest, panel_id, panel_spec)

    def register_secret(self, env_var: str, description: str = "", required: bool = False) -> PluginRegistration:
        """Declare a secret requirement."""
        return self._manager._register_secret(self.manifest, env_var, description, required)

    def get_storage_dir(self) -> Path:
        """Return the plugin's persistent retained-data directory."""
        return plugin_data_dir(self.name, base_dir=self._base_dir)

    def get_db(self, filename: str = "data.db") -> sqlite3.Connection:
        """Open or get an SQLite database connection in the plugin's data directory."""
        return plugin_db(self.name, filename=filename, base_dir=self._base_dir)

    def get_config(self) -> Dict[str, Any]:
        """Return the plugin's resolved configuration block."""
        return dict(self.config)
