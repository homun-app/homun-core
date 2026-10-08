"""Plugin Manager: lifecycle orchestration, registration ledger, and hook dispatch."""
from __future__ import annotations

import inspect
import logging
from pathlib import Path
import shutil
from typing import Any, Callable, Dict, List, Optional, Set

from homun.application.plugin_contracts import (
    LoadedPlugin,
    PluginContext,
    PluginManifest,
    PluginRegistration,
)
from homun.application.plugin_loader import (
    iter_plugin_dirs,
    load_plugin_module,
    read_plugin_manifest,
)
from homun.application.plugin_storage import plugin_data_dir
from homun.tools.registry import ToolEntry

logger = logging.getLogger(__name__)


class PluginManager:
    """Central manager for Homun plugins.

    Maintains a strict registration ledger. Unloading or disabling a plugin releases all
    registered tools, hooks, providers, platforms, commands, skills, panels, and secrets
    in reverse acquisition order so that no stale capabilities linger.
    """

    def __init__(self, base_dir: Optional[Path] = None) -> None:
        self.base_dir = base_dir
        self._plugins: Dict[str, LoadedPlugin] = {}
        self._ownership_ledger: Dict[str, List[PluginRegistration]] = {}
        self._registration_order: List[PluginRegistration] = []
        
        # Capability registries
        self._tools: Dict[str, ToolEntry] = {}
        self._hooks: Dict[str, List[Callable]] = {}
        self._providers: Dict[tuple[str, str], Any] = {}
        self._platforms: Dict[str, Any] = {}
        self._commands: Dict[str, tuple[Callable, str]] = {}
        self._skills: Dict[str, Dict[str, Any]] = {}
        self._panels: Dict[str, Dict[str, Any]] = {}
        self._secrets: Dict[str, Dict[str, Any]] = {}
        self._config: Dict[str, Any] = {}

    def _track(self, registration: PluginRegistration) -> PluginRegistration:
        self._ownership_ledger.setdefault(registration.plugin_key, []).append(registration)
        if not registration.persistent:
            self._registration_order.append(registration)
        return registration

    def _register_tool(self, manifest: PluginManifest, entry: ToolEntry) -> PluginRegistration:
        tool_name = entry.definition.name
        self._tools[tool_name] = entry
        
        def release() -> None:
            self._tools.pop(tool_name, None)

        return self._track(PluginRegistration(
            kind="tool", key=tool_name, release=release, plugin_key=manifest.name
        ))

    def _register_hook(self, manifest: PluginManifest, hook_name: str, callback: Callable) -> PluginRegistration:
        self._hooks.setdefault(hook_name, []).append(callback)

        def release() -> None:
            callbacks = self._hooks.get(hook_name)
            if callbacks and callback in callbacks:
                callbacks.remove(callback)
            if callbacks is not None and not callbacks:
                self._hooks.pop(hook_name, None)

        return self._track(PluginRegistration(
            kind="hook", key=hook_name, release=release, plugin_key=manifest.name
        ))

    def _register_provider(self, manifest: PluginManifest, kind: str, name: str, provider: Any) -> PluginRegistration:
        key = (kind, name)
        self._providers[key] = provider

        def release() -> None:
            self._providers.pop(key, None)

        return self._track(PluginRegistration(
            kind="provider", key=f"{kind}:{name}", release=release, plugin_key=manifest.name
        ))

    def _register_platform(self, manifest: PluginManifest, name: str, adapter: Any) -> PluginRegistration:
        self._platforms[name] = adapter

        def release() -> None:
            self._platforms.pop(name, None)

        return self._track(PluginRegistration(
            kind="platform", key=name, release=release, plugin_key=manifest.name
        ))

    def _register_command(self, manifest: PluginManifest, name: str, handler: Callable, description: str = "") -> PluginRegistration:
        self._commands[name] = (handler, description)

        def release() -> None:
            self._commands.pop(name, None)

        return self._track(PluginRegistration(
            kind="command", key=name, release=release, plugin_key=manifest.name
        ))

    def _register_skill(self, manifest: PluginManifest, name: str, spec: Dict[str, Any]) -> PluginRegistration:
        self._skills[name] = spec

        def release() -> None:
            self._skills.pop(name, None)

        return self._track(PluginRegistration(
            kind="skill", key=name, release=release, plugin_key=manifest.name
        ))

    def _register_panel(self, manifest: PluginManifest, panel_id: str, panel_spec: Dict[str, Any]) -> PluginRegistration:
        self._panels[panel_id] = panel_spec

        def release() -> None:
            self._panels.pop(panel_id, None)

        return self._track(PluginRegistration(
            kind="panel", key=panel_id, release=release, plugin_key=manifest.name
        ))

    def _register_secret(self, manifest: PluginManifest, env_var: str, description: str = "", required: bool = False) -> PluginRegistration:
        self._secrets[env_var] = {"description": description, "required": required, "plugin": manifest.name}

        def release() -> None:
            self._secrets.pop(env_var, None)

        return self._track(PluginRegistration(
            kind="secret", key=env_var, release=release, plugin_key=manifest.name
        ))

    def load_from_directory(self, plugin_dir: Path, config: Optional[Dict[str, Any]] = None) -> LoadedPlugin:
        """Load and register a single plugin from its directory."""
        manifest = read_plugin_manifest(plugin_dir)
        plugin_name = manifest.name
        
        # Check if disabled in global config
        plugin_config = (config or {}).get("plugins", {})
        disabled_set = set(plugin_config.get("disabled", []))
        is_enabled = manifest.name not in disabled_set and manifest.enabled

        module_name = f"homun_plugins.{plugin_name.replace('-', '_')}"
        mod = load_plugin_module(module_name, plugin_dir, logger=logger)

        loaded = LoadedPlugin(
            manifest=manifest,
            install_dir=plugin_dir,
            module=mod,
            enabled=is_enabled,
        )
        self._plugins[plugin_name] = loaded

        if is_enabled and mod and hasattr(mod, "register"):
            ctx = PluginContext(
                name=plugin_name,
                manifest=manifest,
                manager=self,
                config=plugin_config.get(plugin_name, {}),
                base_dir=self.base_dir,
            )
            try:
                mod.register(ctx)
                self.dispatch_hook("on_load", plugin_name=plugin_name)
            except Exception as exc:
                logger.error("Error during register() for plugin %s: %s", plugin_name, exc)
                loaded.error = str(exc)

        return loaded

    def discover_and_load(self, plugins_root: Path, config: Optional[Dict[str, Any]] = None) -> List[LoadedPlugin]:
        """Discover and load all plugins in plugins_root."""
        results = []
        if config:
            self._config = config
        for pdir in iter_plugin_dirs(plugins_root):
            try:
                loaded = self.load_from_directory(pdir, config=self._config)
                results.append(loaded)
            except Exception as exc:
                logger.warning("Failed to load plugin from %s: %s", pdir, exc)
        return results

    def disable(self, plugin_name: str) -> bool:
        """Disable a plugin and release all its capabilities without stale remnants."""
        if plugin_name not in self._plugins:
            return False

        loaded = self._plugins[plugin_name]
        try:
            self.dispatch_hook("on_unload", plugin_name=plugin_name)
        except Exception:
            pass

        # Dispose all registrations in reverse order
        regs = self._ownership_ledger.pop(plugin_name, [])
        for reg in reversed(regs):
            reg.dispose()
        
        # Remove from registration_order
        reg_ids = {id(r) for r in regs}
        self._registration_order = [r for r in self._registration_order if id(r) not in reg_ids]

        loaded.enabled = False
        return True

    def enable(self, plugin_name: str) -> bool:
        """Enable a previously disabled plugin and re-register its capabilities."""
        if plugin_name not in self._plugins:
            return False
        
        loaded = self._plugins[plugin_name]
        if loaded.enabled:
            return True

        mod = loaded.module
        if mod and hasattr(mod, "register"):
            plugin_config = self._config.get("plugins", {}).get(plugin_name, {})
            ctx = PluginContext(
                name=plugin_name,
                manifest=loaded.manifest,
                manager=self,
                config=plugin_config,
                base_dir=self.base_dir,
            )
            try:
                mod.register(ctx)
                loaded.enabled = True
                loaded.error = None
                self.dispatch_hook("on_load", plugin_name=plugin_name)
                return True
            except Exception as exc:
                logger.error("Failed to re-enable plugin %s: %s", plugin_name, exc)
                loaded.error = str(exc)
                return False
        
        loaded.enabled = True
        return True

    def uninstall(self, plugin_name: str, *, purge_data: bool = False) -> bool:
        """Uninstall a plugin.

        Releases all capabilities, removes the install directory, and preserves the
        retained-data directory unless purge_data is explicitly requested.
        """
        if plugin_name not in self._plugins:
            return False

        loaded = self._plugins[plugin_name]
        self.disable(plugin_name)

        # Remove install directory
        if loaded.install_dir and loaded.install_dir.exists():
            try:
                shutil.rmtree(loaded.install_dir)
            except Exception as exc:
                logger.warning("Failed to delete plugin install directory %s: %s", loaded.install_dir, exc)

        # Retained data contract: ONLY remove data if purge_data is explicitly True!
        if purge_data:
            data_dir = plugin_data_dir(plugin_name, base_dir=self.base_dir)
            if data_dir.exists():
                try:
                    shutil.rmtree(data_dir)
                except Exception as exc:
                    logger.warning("Failed to purge plugin data directory %s: %s", data_dir, exc)

        del self._plugins[plugin_name]
        return True

    def reload_config(self, new_config: Dict[str, Any]) -> None:
        """Reload configuration, activating/deactivating plugins and dispatching on_config_reload."""
        self._config = new_config
        plugin_cfg = new_config.get("plugins", {})
        enabled_list: List[str] = plugin_cfg.get("enabled", [])
        disabled_list: List[str] = plugin_cfg.get("disabled", [])

        # Disable plugins present in disabled_list
        for name in disabled_list:
            if name in self._plugins and self._plugins[name].enabled:
                self.disable(name)

        # Enable plugins present in enabled_list
        for name in enabled_list:
            if name in self._plugins and not self._plugins[name].enabled:
                self.enable(name)

        # Dispatch on_config_reload to all active hooks
        self.dispatch_hook("on_config_reload", config=new_config)

    def dispatch_hook(self, hook_name: str, **kwargs: Any) -> List[Any]:
        """Dispatch a hook to all subscribed callbacks.

        Inspects callback parameters to only pass declaring arguments or **kwargs.
        Supports fail-closed policy hooks (e.g. pre_tool_call returning action='block').
        """
        callbacks = list(self._hooks.get(hook_name, []))
        results = []

        for cb in callbacks:
            try:
                sig = inspect.signature(cb)
                has_varkw = any(p.kind == inspect.Parameter.VAR_KEYWORD for p in sig.parameters.values())
                if has_varkw:
                    call_kwargs = kwargs
                else:
                    call_kwargs = {k: v for k, v in kwargs.items() if k in sig.parameters}
                
                res = cb(**call_kwargs)
                results.append(res)

                # Check policy hook block directive
                if hook_name == "pre_tool_call" and isinstance(res, dict) and res.get("action") == "block":
                    logger.info("Hook %s callback %s blocked action: %s", hook_name, cb, res.get("message"))
                    return results

            except Exception as exc:
                logger.warning("Hook %s callback %s raised: %s", hook_name, cb, exc)
                if hook_name == "pre_tool_call":
                    # Fail-closed for pre_tool_call
                    results.append({"action": "block", "message": f"Plugin error: {exc}"})
                    return results

        return results

    def get_tool(self, name: str) -> Optional[ToolEntry]:
        return self._tools.get(name)

    def get_active_tools(self) -> List[ToolEntry]:
        return list(self._tools.values())

    def get_panels(self) -> List[Dict[str, Any]]:
        return [{"id": k, **v} for k, v in self._panels.items()]

    def get_commands(self) -> List[Dict[str, Any]]:
        return [{"name": k, "description": desc} for k, (fn, desc) in self._commands.items()]

    def get_plugin(self, name: str) -> Optional[LoadedPlugin]:
        return self._plugins.get(name)

    def list_plugins(self) -> List[LoadedPlugin]:
        return list(self._plugins.values())

    def summary(self) -> Dict[str, Any]:
        return {
            "plugins_count": len(self._plugins),
            "enabled_count": sum(1 for p in self._plugins.values() if p.enabled),
            "tools_count": len(self._tools),
            "hooks_count": sum(len(cbs) for cbs in self._hooks.values()),
            "panels_count": len(self._panels),
            "commands_count": len(self._commands),
            "plugins": [
                {
                    "name": p.manifest.name,
                    "version": p.manifest.version,
                    "kind": p.manifest.kind,
                    "enabled": p.enabled,
                    "error": p.error,
                    "tools": [t for t in self._tools if self._is_owned_by(t, p.manifest.name, "tool")],
                    "hooks": [h for h in self._hooks if self._is_owned_by(h, p.manifest.name, "hook")],
                }
                for p in self._plugins.values()
            ],
        }

    def _is_owned_by(self, key: str, plugin_name: str, kind: str) -> bool:
        regs = self._ownership_ledger.get(plugin_name, [])
        return any(r.kind == kind and r.key == key and r.active for r in regs)


# Global singleton instance for easy engine access
_GLOBAL_PLUGIN_MANAGER: Optional[PluginManager] = None


def get_plugin_manager(base_dir: Optional[Path] = None) -> PluginManager:
    global _GLOBAL_PLUGIN_MANAGER
    if _GLOBAL_PLUGIN_MANAGER is None:
        _GLOBAL_PLUGIN_MANAGER = PluginManager(base_dir=base_dir)
    return _GLOBAL_PLUGIN_MANAGER


def reset_plugin_manager() -> None:
    global _GLOBAL_PLUGIN_MANAGER
    _GLOBAL_PLUGIN_MANAGER = None
