"""System health diagnostics and auto-repair (doctor) for Homun.

Inspects runtime environment, required tools, terminal backends, storage health,
and configuration schema status with optional automated repair.
"""

from __future__ import annotations

import os
import shutil
import sqlite3
import subprocess
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional
from pydantic import BaseModel, Field

from homun.application.config_lifecycle import ConfigLifecycleManager, CURRENT_CONFIG_SCHEMA_VERSION


class DoctorFinding(BaseModel):
    check_name: str
    category: str = Field(..., description="platform, backend, tools, storage, config")
    passed: bool
    severity: str = Field("info", description="info, warning, error")
    message: str
    remedy: Optional[str] = None
    fixed: bool = False


class DoctorReport(BaseModel):
    all_passed: bool
    findings: List[DoctorFinding] = Field(default_factory=list)
    summary: Dict[str, int] = Field(default_factory=dict)


class DoctorDiagnostics:
    """Executes diagnostic checks across Homun operational boundaries."""

    def __init__(self, data_dir: Path, config_lifecycle: Optional[ConfigLifecycleManager] = None) -> None:
        self.data_dir = data_dir
        self.config_lifecycle = config_lifecycle or ConfigLifecycleManager(data_dir / "config")

    def run_all(self, fix: bool = False) -> DoctorReport:
        """Run all diagnostic checks, optionally applying fixes."""
        findings: List[DoctorFinding] = []

        findings.append(self._check_python_version())
        findings.append(self._check_sqlite_capabilities())
        findings.append(self._check_git_tool())
        findings.append(self._check_ripgrep_tool())
        findings.append(self._check_node_runtime())
        findings.append(self._check_docker_backend())
        findings.append(self._check_local_shell_backend())
        findings.append(self._check_ssh_tool())
        findings.extend(self._check_storage_and_database(fix=fix))
        findings.append(self._check_config_and_migrations(fix=fix))

        passed_count = sum(1 for f in findings if f.passed)
        warn_count = sum(1 for f in findings if not f.passed and f.severity == "warning")
        error_count = sum(1 for f in findings if not f.passed and f.severity == "error")

        all_ok = error_count == 0

        return DoctorReport(
            all_passed=all_ok,
            findings=findings,
            summary={
                "total": len(findings),
                "passed": passed_count,
                "warnings": warn_count,
                "errors": error_count,
                "fixed": sum(1 for f in findings if f.fixed),
            },
        )

    def _check_python_version(self) -> DoctorFinding:
        v = sys.version_info
        passed = v.major == 3 and v.minor >= 12
        return DoctorFinding(
            check_name="python_version",
            category="platform",
            passed=passed,
            severity="error" if not passed else "info",
            message=f"Python {v.major}.{v.minor}.{v.micro} detected",
            remedy="Install Python 3.12 or newer" if not passed else None,
        )

    def _check_sqlite_capabilities(self) -> DoctorFinding:
        try:
            con = sqlite3.connect(":memory:")
            # Test JSON and FTS5 support
            con.execute("SELECT json('{\"ok\": true}')")
            con.execute("CREATE VIRTUAL TABLE _test_fts USING fts5(content)")
            con.close()
            return DoctorFinding(
                check_name="sqlite_capabilities",
                category="platform",
                passed=True,
                severity="info",
                message=f"SQLite {sqlite3.sqlite_version} with JSON1 and FTS5 enabled",
            )
        except Exception as exc:
            return DoctorFinding(
                check_name="sqlite_capabilities",
                category="platform",
                passed=False,
                severity="error",
                message=f"SQLite capability check failed: {exc}",
                remedy="Ensure SQLite is compiled with JSON1 and FTS5 support",
            )

    def _check_git_tool(self) -> DoctorFinding:
        git_path = shutil.which("git")
        passed = git_path is not None
        return DoctorFinding(
            check_name="git_tool",
            category="tools",
            passed=passed,
            severity="error" if not passed else "info",
            message=f"Git binary found at {git_path}" if passed else "git binary not found on PATH",
            remedy="Install git for checkpointing and workspace diffs" if not passed else None,
        )

    def _check_ripgrep_tool(self) -> DoctorFinding:
        rg_path = shutil.which("rg")
        passed = rg_path is not None
        return DoctorFinding(
            check_name="ripgrep_tool",
            category="tools",
            passed=passed,
            severity="warning" if not passed else "info",
            message=f"ripgrep (rg) found at {rg_path}" if passed else "ripgrep (rg) not found on PATH (fallback used)",
            remedy="Install ripgrep for accelerated workspace searches" if not passed else None,
        )

    def _check_node_runtime(self) -> DoctorFinding:
        node_path = shutil.which("node")
        passed = node_path is not None
        return DoctorFinding(
            check_name="node_runtime",
            category="tools",
            passed=passed,
            severity="warning" if not passed else "info",
            message=f"Node.js found at {node_path}" if passed else "Node.js runtime not found on PATH",
            remedy="Install node for web UI builds and MCP stdio servers" if not passed else None,
        )

    def _check_docker_backend(self) -> DoctorFinding:
        docker_path = shutil.which("docker")
        if not docker_path:
            return DoctorFinding(
                check_name="docker_backend",
                category="backend",
                passed=False,
                severity="warning",
                message="Docker CLI binary not found on PATH",
                remedy="Install Docker Desktop or Docker engine for containerized terminal backend",
            )

        try:
            res = subprocess.run(
                ["docker", "info"],
                capture_output=True,
                text=True,
                timeout=3.0,
            )
            passed = (res.returncode == 0)
            return DoctorFinding(
                check_name="docker_backend",
                category="backend",
                passed=passed,
                severity="info" if passed else "warning",
                message="Docker daemon is running and reachable" if passed else "Docker daemon is not running",
                remedy="Start the Docker daemon" if not passed else None,
            )
        except Exception:
            return DoctorFinding(
                check_name="docker_backend",
                category="backend",
                passed=False,
                severity="warning",
                message="Docker daemon probe timed out or failed",
                remedy="Verify Docker daemon status",
            )

    def _check_local_shell_backend(self) -> DoctorFinding:
        shell_path = shutil.which("zsh") or shutil.which("bash") or shutil.which("sh")
        passed = shell_path is not None
        return DoctorFinding(
            check_name="local_shell_backend",
            category="backend",
            passed=passed,
            severity="error" if not passed else "info",
            message=f"Local shell backend available at {shell_path}" if passed else "No standard shell found",
        )

    def _check_ssh_tool(self) -> DoctorFinding:
        ssh_path = shutil.which("ssh")
        passed = ssh_path is not None
        return DoctorFinding(
            check_name="ssh_tool",
            category="backend",
            passed=passed,
            severity="info" if passed else "warning",
            message=f"SSH client found at {ssh_path}" if passed else "SSH client not found on PATH",
            remedy="Install openssh-client if remote SSH terminal backend is desired" if not passed else None,
        )

    def _check_storage_and_database(self, fix: bool = False) -> List[DoctorFinding]:
        findings = []

        # 1. Directory permissions
        dir_ok = os.access(self.data_dir, os.W_OK) if self.data_dir.exists() else False
        fixed_dir = False
        if not self.data_dir.exists() and fix:
            self.data_dir.mkdir(parents=True, exist_ok=True)
            dir_ok = True
            fixed_dir = True

        findings.append(DoctorFinding(
            check_name="storage_directory",
            category="storage",
            passed=dir_ok,
            severity="error" if not dir_ok else "info",
            message=f"Data directory {self.data_dir} is writable",
            remedy="Check write permissions for Homun data directory",
            fixed=fixed_dir,
        ))

        # 2. Database integrity
        db_path = self.data_dir / "homun.db"
        if db_path.exists():
            try:
                con = sqlite3.connect(str(db_path))
                res = con.execute("PRAGMA integrity_check").fetchall()
                con.close()
                passed = (res == [("ok",)])
                findings.append(DoctorFinding(
                    check_name="database_integrity",
                    category="storage",
                    passed=passed,
                    severity="error" if not passed else "info",
                    message="SQLite database integrity check passed" if passed else f"Integrity check failed: {res}",
                    remedy="Restore database from latest backup" if not passed else None,
                ))
            except Exception as exc:
                findings.append(DoctorFinding(
                    check_name="database_integrity",
                    category="storage",
                    passed=False,
                    severity="error",
                    message=f"Failed to inspect database: {exc}",
                ))
        else:
            findings.append(DoctorFinding(
                check_name="database_integrity",
                category="storage",
                passed=True,
                severity="info",
                message="Database does not exist yet; will be created on startup",
            ))

        return findings

    def _check_config_and_migrations(self, fix: bool = False) -> DoctorFinding:
        raw = self.config_lifecycle.load_raw_config()
        current_v = self.config_lifecycle.get_schema_version(raw)
        up_to_date = (current_v == CURRENT_CONFIG_SCHEMA_VERSION)

        fixed = False
        if not up_to_date and fix:
            res = self.config_lifecycle.migrate()
            if res.success:
                up_to_date = True
                fixed = True

        return DoctorFinding(
            check_name="config_schema_version",
            category="config",
            passed=up_to_date,
            severity="warning" if not up_to_date else "info",
            message=f"Config schema version is {CURRENT_CONFIG_SCHEMA_VERSION}" if up_to_date else f"Config schema is v{current_v} (target v{CURRENT_CONFIG_SCHEMA_VERSION})",
            remedy="Run configuration migration to update schema" if not up_to_date else None,
            fixed=fixed,
        )
