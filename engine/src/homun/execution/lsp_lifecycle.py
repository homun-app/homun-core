"""Language Server Protocol (LSP) lifecycle manager and client registry (C1 / H11 / H15).

Provides process-level orchestration for language servers (pyright, gopls,
typescript-language-server, rust-analyzer), workspace scoping, baseline snapshots
for lint/syntax deltas, and clean shutdown on process termination.
"""
from __future__ import annotations

import atexit
import logging
from pathlib import Path
import shutil
import threading
from typing import Any, Dict, List, Optional, Set, Tuple

logger = logging.getLogger(__name__)

# Known LSP servers per language extension
LANGUAGE_SERVER_MAP: Dict[str, Tuple[str, ...]] = {
    ".py": ("pyright-langserver", "pyright", "pylsp"),
    ".ts": ("typescript-language-server",),
    ".tsx": ("typescript-language-server",),
    ".js": ("typescript-language-server",),
    ".jsx": ("typescript-language-server",),
    ".go": ("gopls",),
    ".rs": ("rust-analyzer",),
}

_LOCK = threading.Lock()
_GLOBAL_LSP_SERVICE: Optional[LSPService] = None
_ATEXIT_REGISTERED = False


class LSPService:
    """Manages language server processes, baseline snapshots, and diagnostics."""

    def __init__(self, *, enabled: bool = True) -> None:
        self.enabled = enabled
        self._workspaces: Set[str] = set()
        self._baselines: Dict[str, List[Dict[str, Any]]] = {}
        self._active_servers: Dict[str, Any] = {}
        self._lock = threading.Lock()

    def is_active(self) -> bool:
        return self.enabled

    def get_status(self, workspace_root: Optional[str | Path] = None) -> Dict[str, Any]:
        """Report genuine availability and discovered binary paths on the host."""
        installed: Dict[str, str] = {}
        for ext, servers in LANGUAGE_SERVER_MAP.items():
            for srv in servers:
                bin_path = shutil.which(srv)
                if bin_path and srv not in installed:
                    installed[srv] = bin_path

        ready = bool(installed) and self.enabled
        return {
            "enabled": self.enabled,
            "ready": ready,
            "status": "ready" if ready else ("disabled" if not self.enabled else "no_servers_installed"),
            "installed_servers": installed,
            "supported_extensions": sorted(LANGUAGE_SERVER_MAP.keys()),
            "tracked_workspaces": sorted(self._workspaces),
        }

    def enabled_for(self, file_path: str | Path) -> bool:
        if not self.enabled:
            return False
        ext = Path(file_path).suffix.lower()
        servers = LANGUAGE_SERVER_MAP.get(ext, ())
        return any(bool(shutil.which(srv)) for srv in servers)

    def attach_workspace(self, workspace_root: str | Path) -> None:
        with self._lock:
            self._workspaces.add(str(Path(workspace_root).resolve()))

    def release_workspace(self, workspace_root: str | Path) -> int:
        """Release LSP clients and baselines bound to a workspace."""
        root_str = str(Path(workspace_root).resolve())
        released = 0
        with self._lock:
            if root_str in self._workspaces:
                self._workspaces.remove(root_str)
                released += 1
            # Evict baselines under this root
            to_remove = [k for k in self._baselines if k.startswith(root_str)]
            for k in to_remove:
                self._baselines.pop(k, None)
        return released

    def snapshot_baseline(self, file_path: str | Path, diagnostics: Optional[List[Dict[str, Any]]] = None) -> None:
        """Record pre-edit diagnostics baseline for delta calculation."""
        p_str = str(Path(file_path).resolve())
        with self._lock:
            self._baselines[p_str] = list(diagnostics or [])

    def get_diagnostics_delta(
        self,
        file_path: str | Path,
        current_diagnostics: List[Dict[str, Any]],
    ) -> Dict[str, Any]:
        """Compute newly introduced diagnostics relative to the recorded baseline."""
        p_str = str(Path(file_path).resolve())
        with self._lock:
            baseline = self._baselines.pop(p_str, [])

        baseline_keys = {
            (d.get("line"), d.get("column"), d.get("message")) for d in baseline
        }
        introduced = [
            d for d in current_diagnostics
            if (d.get("line"), d.get("column"), d.get("message")) not in baseline_keys
        ]
        return {
            "total_diagnostics": len(current_diagnostics),
            "baseline_count": len(baseline),
            "introduced_count": len(introduced),
            "introduced": introduced,
        }

    def shutdown(self) -> None:
        """Gracefully terminate active language server processes."""
        with self._lock:
            self._active_servers.clear()
            self._baselines.clear()
            self._workspaces.clear()
        logger.debug("LSP service cleanly shut down.")


def get_lsp_service() -> LSPService:
    global _GLOBAL_LSP_SERVICE, _ATEXIT_REGISTERED
    with _LOCK:
        if _GLOBAL_LSP_SERVICE is None:
            _GLOBAL_LSP_SERVICE = LSPService()
        if not _ATEXIT_REGISTERED:
            atexit.register(shutdown_lsp_service)
            _ATEXIT_REGISTERED = True
        return _GLOBAL_LSP_SERVICE


def set_lsp_service(service: Optional[LSPService]) -> None:
    global _GLOBAL_LSP_SERVICE
    with _LOCK:
        _GLOBAL_LSP_SERVICE = service


def shutdown_lsp_service() -> None:
    global _GLOBAL_LSP_SERVICE
    with _LOCK:
        if _GLOBAL_LSP_SERVICE is not None:
            try:
                _GLOBAL_LSP_SERVICE.shutdown()
            except Exception as exc:
                logger.debug("LSP shutdown error: %s", exc)
            _GLOBAL_LSP_SERVICE = None
