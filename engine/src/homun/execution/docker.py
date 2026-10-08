"""Reconnectable container jobs with durable, at-most-once dispatch intent.

Docker hardening, unprivileged user execution, and persistent intent boundaries.
"""
from __future__ import annotations

import json
import os
import re
from pathlib import Path

from homun.domain.errors import ConflictError, PermissionDeniedError

from .cli import DockerCLI
from .contracts import ExecutionTimeout, ExecutionUnavailable, ExecutionUncertain, JobSpec, digest
from .layout import confine_directory
from .workspace import owned_root, working_directory


class DockerJobs:
    def __init__(self, root: Path, *, client=None):
        self.root = Path(root).absolute()
        self.client = client if client is not None else DockerCLI()
        self._directory(self.root)

    @staticmethod
    def _directory(path: Path) -> Path:
        return confine_directory(path)

    def _workspace_identity(self, job: JobSpec) -> str:
        return digest(str(self.root / "workspaces" / job.owner))

    def workspace(self, job: JobSpec) -> Path:
        return owned_root(self.root, job.workspace_id, job.run_id)

    def _intent(self, job: JobSpec) -> bool:
        directory = self._directory(self.root / "intents")
        path = directory / (job.identity + ".json")
        if path.is_symlink():
            raise PermissionDeniedError("Execution intent must not be a symlink")
        try:
            fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        except FileExistsError:
            try:
                with path.open("rb") as stream:
                    raw = stream.read(4097)
                if len(raw) > 4096:
                    raise ValueError("Oversize intent")
                existing = json.loads(raw)
                contract = existing["contract"]
            except (OSError, ValueError, KeyError, TypeError):
                raise ExecutionUncertain("Execution intent is incomplete; command will not be repeated") from None
            if contract != job.contract:
                raise ConflictError("Execution identity is already bound to another contract")
            return False
        with os.fdopen(fd, "w") as stream:
            json.dump({"contract": job.contract}, stream)
            stream.flush()
            os.fsync(stream.fileno())
        directory_fd = os.open(directory, os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
        return True

    def _inspect(self, job: JobSpec) -> dict | None:
        reply = self.client.run(["container", "inspect", job.name])
        if reply.returncode:
            if not reply.truncated and re.search(r"(?:No such container|No such object)(?::|\s|$)", reply.output):
                return None
            raise ExecutionUnavailable("Container state could not be read")
        try:
            rows = json.loads(reply.output) if not reply.truncated else None
            if not isinstance(rows, list) or len(rows) != 1:
                raise ValueError("Invalid container inspection")
            row = rows[0]
            labels = row["Config"]["Labels"]
            if labels.get("io.homun.owner") != job.owner or labels.get("io.homun.contract") != job.contract or labels.get("io.homun.workspace") != self._workspace_identity(job):
                raise PermissionDeniedError("Container does not belong to this job contract")
            state = row["State"]
            if not re.fullmatch(r"[a-f0-9]{64}", row["Id"]) or type(state["Running"]) is not bool:
                raise ValueError("Invalid container state")
            if state["Status"] not in {"created", "running", "paused", "restarting", "removing", "exited", "dead"}:
                raise ValueError("Unknown container state")
            if type(state["ExitCode"]) is not int or type(state["OOMKilled"]) is not bool:
                raise ValueError("Invalid container exit state")
            return {"container_id": row["Id"], "status": state["Status"], "running": state["Running"],
                    "exit_code": state["ExitCode"] if state["Status"] in {"exited", "dead"} else None,
                    "oom_killed": state["OOMKilled"]}
        except (ValueError, KeyError, TypeError, AttributeError):
            raise ExecutionUnavailable("Container returned an invalid state") from None

    def inspect(self, job: JobSpec) -> dict:
        state = self._inspect(job)
        if state is None:
            raise ExecutionUncertain("Container is missing; command will not be repeated")
        return state

    def start(self, job: JobSpec, *, stdin: bool = False, pty: bool = False) -> dict:
        # Revalidate even when a caller used Pydantic's unchecked model_copy.
        job = JobSpec.model_validate(job.model_dump())
        workspace = self.workspace(job)
        fresh = self._intent(job)
        existing = self._inspect(job)
        if existing is not None:
            return existing
        if not fresh:
            raise ExecutionUncertain("Recorded command has no container; automatic redispatch is forbidden")
        working_directory(workspace, job.cwd)
        if any(c in str(workspace) for c in (",", "\n", "\r")):
            raise PermissionDeniedError("Workspace path cannot be represented as a Docker mount")
        if pty:stdin = True
        args = ["run", "--detach", *(["--interactive"] if stdin else []), *(["--tty"] if pty else []), "--name", job.name, "--pull=never", "--network=none", "--init",
                "--cap-drop=ALL", "--security-opt=no-new-privileges", "--pids-limit=64", "--memory=512m",
                "--cpus=1", "--workdir=" + ("/workspace" if job.cwd == "." else "/workspace/" + job.cwd), "--mount", f"type=bind,src={workspace},dst=/workspace",
                "--label", f"io.homun.owner={job.owner}", "--label", f"io.homun.contract={job.contract}",
                "--label", f"io.homun.workspace={self._workspace_identity(job)}",
                "--entrypoint", "/bin/sh", job.image, "-lc", job.command]
        try:
            self.client.run(args)
        except (ExecutionTimeout, ExecutionUnavailable):
            # A failed CLI transport is not evidence that Docker did not execute.
            pass
        return self.inspect(job)

    def stdin_open(self, job: JobSpec) -> bool:
        reply = self.client.run(["container", "inspect", job.name])
        if reply.returncode or reply.truncated:
            raise ExecutionUnavailable("Container stdin state could not be read")
        try:
            rows = json.loads(reply.output)
            if not isinstance(rows, list) or len(rows) != 1:
                raise ValueError("Invalid stdin state")
            opened = rows[0]["Config"]["OpenStdin"]
            if type(opened) is not bool:
                raise ValueError("Invalid stdin state")
            labels = rows[0]["Config"]["Labels"]
            if labels.get("io.homun.owner") != job.owner or labels.get("io.homun.contract") != job.contract:
                raise PermissionDeniedError("Container does not belong to this job contract")
            return opened
        except (ValueError, KeyError, TypeError, AttributeError):
            raise ExecutionUnavailable("Container returned an invalid stdin state") from None

    def write_stdin(self, job: JobSpec, payload: bytes) -> None:
        from homun.execution.docker_stdin import send
        state = self.inspect(job)
        if not state["running"] or not self.stdin_open(job):
            raise ExecutionUnavailable("Process stdin is not open")
        send(self.client.socket_path(), state["container_id"], payload)

    def stop(self, job: JobSpec) -> dict:
        state = self.inspect(job)
        reply = self.client.run(["stop", "--time", "5", state["container_id"]])
        if reply.returncode:
            raise ExecutionUncertain("Container stop could not be confirmed")
        return self.inspect(job)

    def remove(self, job: JobSpec) -> None:
        state = self.inspect(job)
        reply = self.client.run(["rm", "--force", "--volumes", state["container_id"]])
        if reply.returncode:
            raise ExecutionUncertain("Container removal could not be confirmed")
        # Intent and workspace survive removal; no silent reexecution or artifact deletion.

    def logs(self, job: JobSpec, *, max_bytes: int = 65536) -> dict:
        state = self.inspect(job)
        reply = self.client.run(["logs", "--tail", "1000", state["container_id"]], max_bytes=max_bytes)
        if reply.returncode:
            raise ExecutionUnavailable("Container logs could not be read")
        return {"text": reply.output, "truncated": reply.truncated, "tail_only": True, "line_limit": 1000}
