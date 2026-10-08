"""Plugin loader: dynamic discovery, sibling submodule resolution, and manifest parsing."""
from __future__ import annotations

import importlib.machinery
import importlib.util
import json
import logging
from pathlib import Path
import sys
from typing import Any, List, Optional

from homun.application.plugin_contracts import LoadedPlugin, PluginContext, PluginManifest

_log = logging.getLogger(__name__)


def read_plugin_manifest(plugin_dir: Path) -> PluginManifest:
    """Read plugin manifest from plugin.yaml, plugin.json, or synthesize default."""
    yaml_file = plugin_dir / "plugin.yaml"
    yml_file = plugin_dir / "plugin.yml"
    json_file = plugin_dir / "plugin.json"

    data = {}
    if yaml_file.exists():
        try:
            import yaml
            with open(yaml_file, encoding="utf-8") as f:
                data = yaml.safe_load(f) or {}
        except Exception as exc:
            _log.warning("Failed to parse YAML manifest in %s: %s", plugin_dir, exc)
    elif yml_file.exists():
        try:
            import yaml
            with open(yml_file, encoding="utf-8") as f:
                data = yaml.safe_load(f) or {}
        except Exception as exc:
            _log.warning("Failed to parse YAML manifest in %s: %s", plugin_dir, exc)
    elif json_file.exists():
        try:
            with open(json_file, encoding="utf-8") as f:
                data = json.load(f) or {}
        except Exception as exc:
            _log.warning("Failed to parse JSON manifest in %s: %s", plugin_dir, exc)

    if not isinstance(data, dict):
        data = {}
    if "name" not in data or not data["name"]:
        data["name"] = plugin_dir.name

    return PluginManifest.model_validate(data)


def register_synthetic_package(name: str, search_locations: List[str]) -> None:
    """Register an empty package namespace in sys.modules so child imports resolve."""
    if name in sys.modules:
        return
    spec = importlib.machinery.ModuleSpec(name, None, is_package=True)
    spec.submodule_search_locations = search_locations
    sys.modules[name] = importlib.util.module_from_spec(spec)


def load_plugin_module(
    module_name: str,
    plugin_dir: Path,
    *,
    logger: Optional[logging.Logger] = None,
) -> Optional[Any]:
    """Import ``plugin_dir/__init__.py`` as module_name with sibling isolation.

    Siblings are pre-loaded so relative imports work. Failed siblings are removed from
    sys.modules so they remain catchable as ModuleNotFoundError.
    """
    log = logger or _log
    init_file = plugin_dir / "__init__.py"
    if not init_file.exists():
        return None

    cached = sys.modules.get(module_name)
    if cached is not None and getattr(cached, "__file__", None):
        return cached

    # Synthetic root namespace
    if "." in module_name:
        parent_name = module_name.rsplit(".", 1)[0]
        register_synthetic_package(parent_name, [])

    spec = importlib.util.spec_from_file_location(
        module_name, str(init_file), submodule_search_locations=[str(plugin_dir)]
    )
    if not spec or not spec.loader:
        return None

    mod = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = mod

    loaded_submodules = []
    for sub_file in plugin_dir.glob("*.py"):
        if sub_file.name == "__init__.py":
            continue
        full_sub_name = f"{module_name}.{sub_file.stem}"
        if full_sub_name in sys.modules:
            continue
        sub_spec = importlib.util.spec_from_file_location(full_sub_name, str(sub_file))
        if not sub_spec or not sub_spec.loader:
            continue
        sub_mod = importlib.util.module_from_spec(sub_spec)
        sys.modules[full_sub_name] = sub_mod
        try:
            sub_spec.loader.exec_module(sub_mod)
            loaded_submodules.append((sub_file.stem, sub_mod))
        except Exception as exc:
            log.debug("Sibling %s failed to exec: %s", full_sub_name, exc)
            sys.modules.pop(full_sub_name, None)

    try:
        spec.loader.exec_module(mod)
    except Exception as exc:
        log.warning("Failed to exec plugin %s: %s", module_name, exc)
        sys.modules.pop(module_name, None)
        return None

    for sub_stem, sub_mod in loaded_submodules:
        setattr(mod, sub_stem, sub_mod)

    return mod


def iter_plugin_dirs(root: Path) -> List[Path]:
    """Return sorted child directories of root containing a plugin manifest or __init__.py."""
    if not root.is_dir():
        return []
    dirs: List[Path] = []
    for child in sorted(root.iterdir()):
        if child.name.startswith(("_", ".")):
            continue
        try:
            if child.is_dir() and (
                (child / "__init__.py").exists()
                or (child / "plugin.yaml").exists()
                or (child / "plugin.json").exists()
            ):
                dirs.append(child)
        except OSError as exc:
            _log.warning("Skipping unreadable plugin directory %s: %s", child, exc)
    return dirs
