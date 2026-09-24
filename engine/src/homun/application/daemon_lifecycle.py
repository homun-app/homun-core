"""Daemon lifecycle management and service control for Homun.

Manages pidfiles, process liveness checks, graceful termination, and service status.
"""

from __future__ import annotations

import os
import signal
import sys
import time
from pathlib import Path
from typing import Any, Dict, Optional
from pydantic import BaseModel, Field


class DaemonStatus(BaseModel):
    state: str = Field(..., description="stopped, running, stale_pid")
    pid: Optional[int] = None
    uptime_seconds: Optional[float] = None
    pid_file: str
    is_alive: bool = False


class DaemonManager:
    """Controls background daemon process execution and liveness."""

    def __init__(self, run_dir: Path) -> None:
        self.run_dir = run_dir
        self.run_dir.mkdir(parents=True, exist_ok=True)
        self.pid_file = self.run_dir / "homun.pid"

    def write_pid(self, pid: Optional[int] = None) -> int:
        """Record PID for the running service."""
        target_pid = pid or os.getpid()
        self.pid_file.write_text(str(target_pid), encoding="utf-8")
        return target_pid

    def read_pid(self) -> Optional[int]:
        """Read recorded PID if file exists."""
        if not self.pid_file.exists():
            return None
        try:
            return int(self.pid_file.read_text(encoding="utf-8").strip())
        except Exception:
            return None

    def clear_pid(self) -> None:
        """Remove PID file."""
        if self.pid_file.exists():
            try:
                self.pid_file.unlink()
            except OSError:
                pass

    def is_pid_alive(self, pid: int) -> bool:
        """Check if process with pid is running."""
        if pid <= 0:
            return False
        try:
            os.kill(pid, 0)
            return True
        except OSError:
            return False

    def status(self) -> DaemonStatus:
        """Report daemon liveness status."""
        pid = self.read_pid()
        if pid is None:
            return DaemonStatus(
                state="stopped",
                pid=None,
                pid_file=str(self.pid_file),
                is_alive=False,
            )

        alive = self.is_pid_alive(pid)
        if alive:
            mtime = self.pid_file.stat().st_mtime
            uptime = max(0.0, time.time() - mtime)
            return DaemonStatus(
                state="running",
                pid=pid,
                uptime_seconds=uptime,
                pid_file=str(self.pid_file),
                is_alive=True,
            )

        return DaemonStatus(
            state="stale_pid",
            pid=pid,
            pid_file=str(self.pid_file),
            is_alive=False,
        )

    def stop(self, timeout_seconds: float = 5.0) -> Dict[str, Any]:
        """Signal running daemon to terminate gracefully."""
        pid = self.read_pid()
        if pid is None or not self.is_pid_alive(pid):
            self.clear_pid()
            return {"success": True, "message": "Daemon was not running", "stopped_pid": pid}

        try:
            os.kill(pid, signal.SIGTERM)
        except OSError as exc:
            return {"success": False, "message": f"Failed to send SIGTERM: {exc}", "pid": pid}

        deadline = time.time() + timeout_seconds
        while time.time() < deadline:
            if not self.is_pid_alive(pid):
                self.clear_pid()
                return {"success": True, "message": "Daemon stopped gracefully", "stopped_pid": pid}
            time.sleep(0.1)

        # Force kill if still alive
        try:
            os.kill(pid, signal.SIGKILL)
            self.clear_pid()
            return {"success": True, "message": "Daemon forcibly terminated", "stopped_pid": pid}
        except OSError as exc:
            return {"success": False, "message": f"Failed to SIGKILL: {exc}", "pid": pid}

    def restart(self, timeout_seconds: float = 5.0) -> Dict[str, Any]:
        """Stop running daemon and signal restart readiness."""
        stop_res = self.stop(timeout_seconds=timeout_seconds)
        return {
            "success": stop_res.get("success", False),
            "action": "restart",
            "previous_status": stop_res,
            "ready_for_start": True,
        }
