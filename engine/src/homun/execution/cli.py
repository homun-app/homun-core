"""Bounded Docker CLI transport. Commands never pass through a host shell."""
from __future__ import annotations

import os
import shutil
import signal
import subprocess
import threading
from dataclasses import dataclass

from .contracts import ExecutionTimeout, ExecutionUnavailable


@dataclass(frozen=True)
class Reply:
    returncode: int
    output: str
    truncated: bool


class DockerCLI:
    def __init__(self, executable: str | None = None):
        self.executable = executable or shutil.which("docker")

    def run(self, args: list[str], *, timeout: float = 20, max_bytes: int = 131072) -> Reply:
        if not self.executable:
            raise ExecutionUnavailable("Docker CLI is unavailable")
        if timeout <= 0 or not 1 <= max_bytes <= 1048576:
            raise ValueError("Invalid transport bounds")
        try:
            process = subprocess.Popen(
                [self.executable, *args], stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True,
            )
        except OSError:
            raise ExecutionUnavailable("Docker CLI could not be started") from None
        retained = bytearray()
        clipped = False

        def drain() -> None:
            nonlocal clipped
            assert process.stdout is not None
            try:
                while chunk := process.stdout.read(8192):
                    available = max_bytes - len(retained)
                    retained.extend(chunk[:available])
                    clipped = clipped or len(chunk) > available
            finally:
                process.stdout.close()

        reader = threading.Thread(target=drain, daemon=True)
        reader.start()
        try:
            process.wait(timeout=timeout)
            reader.join(timeout=timeout)
            if reader.is_alive():
                raise subprocess.TimeoutExpired(self.executable, timeout)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait()
            reader.join(timeout=1)
            raise ExecutionTimeout("Docker transport timed out; execution may have occurred") from None
        return Reply(process.returncode, retained.decode("utf-8", errors="replace"), clipped)
