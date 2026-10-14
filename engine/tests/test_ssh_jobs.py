"""Approved SSH commands reach a disposable local server and do not restart."""
import getpass
import shutil
import socket
import subprocess
import time
from pathlib import Path

import pytest

from homun.execution.contracts import SshJobSpec
from homun.execution.ssh_jobs import SshJobs, key_fingerprint
from test_agent_runs import setup


class Server:
    """Porta effimera e attesa attiva: pronto quando risponde, non dopo un tempo fisso."""

    START_ATTEMPTS = 3
    READY_TIMEOUT_S = 10.0

    def __init__(self, root: Path):
        self.root = root
        self.root.mkdir(mode=0o700)
        subprocess.run(["/usr/bin/ssh-keygen", "-q", "-t", "ed25519", "-f", str(root / "host"), "-N", ""], check=True)
        subprocess.run(["/usr/bin/ssh-keygen", "-q", "-t", "ed25519", "-f", str(root / "client"), "-N", ""], check=True)
        (root / "client").chmod(0o600)
        self.user = getpass.getuser()
        self.host_key = subprocess.run(["/usr/bin/ssh-keygen", "-y", "-f", str(root / "host")],
                                       check=True, capture_output=True, text=True).stdout.split()
        self.host_key = " ".join(self.host_key[:2])
        self.homes: list[Path] = []
        log = root / "sshd.log"
        last_reason = "sshd.log is empty"
        for _ in range(self.START_ATTEMPTS):
            self.port = _free_port()
            (root / "sshd_config").write_text(
                f"Port {self.port}\nListenAddress 127.0.0.1\nHostKey {root / 'host'}\nPidFile {root / 'sshd.pid'}\n"
                f"AuthorizedKeysFile {root / 'client.pub'}\nPasswordAuthentication no\nKbdInteractiveAuthentication no\n"
                "UsePAM no\nStrictModes no\nPrintMotd no\n")
            # ogni tentativo racconta solo se stesso nel log
            log.unlink(missing_ok=True)
            self.process = subprocess.Popen(["/usr/sbin/sshd", "-f", str(root / "sshd_config"), "-E", str(log), "-D"])
            if self._wait_until_ready():
                return
            last_reason = log.read_text() if log.exists() else "(sshd.log missing)"
            if _port_busy(last_reason):
                continue  # porta presa tra la scelta e il bind: riprova con una nuova
            self.close()
            raise AssertionError(
                f"sshd never accepted connections on 127.0.0.1:{self.port} "
                f"within {self.READY_TIMEOUT_S}s\nsshd.log:\n{last_reason}")
        self.close()
        raise AssertionError(
            f"sshd could not bind any of {self.START_ATTEMPTS} free ports\nsshd.log:\n{last_reason}")

    def _wait_until_ready(self) -> bool:
        deadline = time.monotonic() + self.READY_TIMEOUT_S
        while time.monotonic() < deadline:
            if self.process.poll() is not None:
                return False
            try:
                with socket.create_connection(("127.0.0.1", self.port), timeout=0.25):
                    return True
            except OSError:
                time.sleep(0.05)
        return False

    def close(self):
        self.process.terminate()
        try:
            self.process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            self.process.kill()
        for home in self.homes:
            shutil.rmtree(home, ignore_errors=True)


def _free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def _port_busy(log: str) -> bool:
    return "Address already in use" in log or "Cannot bind any address" in log


def spec(server: Server, run_id: str, command: str) -> SshJobSpec:
    job = SshJobSpec(workspace_id="ws", run_id=run_id, call_id="call", command=command, host="127.0.0.1",
                     user=server.user, port=server.port, host_key=server.host_key,
                     key_fingerprint=key_fingerprint(str(server.root / "client")), key_path=str(server.root / "client"))
    server.homes.append(Path.home() / f"homun-{job.owner[:32]}")
    return job


def finished(jobs: SshJobs, job: SshJobSpec) -> dict:
    state = jobs.inspect(job)
    for _ in range(50):
        if state["running"] is not True:
            return state
        time.sleep(0.05)
        state = jobs.inspect(job)
    return state


@pytest.fixture
def server(tmp_path):
    running = Server(tmp_path / "sshd")
    try:
        yield running
    finally:
        running.close()


def test_ssh_command_hides_parent_environment_and_does_not_restart(server, monkeypatch):
    monkeypatch.setenv("SENTINEL", "hidden-value")
    jobs = SshJobs(server.root / "exec")
    job = spec(server, "once", "pwd > where.txt; printf SENTINEL=%s \"$SENTINEL\" >> where.txt")
    jobs.start(job)
    state = finished(jobs, job)
    assert state["status"] == "exited" and state["exit_code"] == 0, jobs.logs(job)["text"]
    text = (server.homes[-1] / "where.txt").read_text()
    assert text.startswith(str(server.homes[-1]))
    assert "hidden-value" not in text
    before = (server.homes[-1] / "where.txt").read_bytes()
    assert jobs.start(job)["exit_code"] == 0
    assert (server.homes[-1] / "where.txt").read_bytes() == before


def test_approved_ssh_run_executes_once(setup, server, monkeypatch):
    from types import SimpleNamespace
    from homun.application.agent.runs import runs as agent_runs
    from homun.application.computer import terminal_jobs
    from homun.application.agent.runs.run_execution import advance
    from homun.application.agent.terminal.terminal import resume
    from homun.execution.contracts import digest
    from homun.models.native_turn import NativeMessage, ToolCall
    monkeypatch.setenv('SENTINEL', 'hidden-value')
    ctx, actor, work, _ = setup
    ctx.models.set_active('openai_compatible')
    key = str(server.root / 'client')
    body = {'command_id': 'run', 'expected_version': 1, 'material_ids': [], 'terminal_backend': 'ssh',
            'ssh_host': '127.0.0.1', 'ssh_user': server.user, 'ssh_port': server.port,
            'ssh_host_key': server.host_key, 'ssh_key_path': key, 'memory': False, 'skills': False}
    proposal = agent_runs.propose(ctx, actor, work, body)
    assert agent_runs.propose(ctx, actor, work, body)['id'] == proposal['id']
    assert 'key_path' not in proposal['terminal']
    names = [item['name'] for item in proposal['tools']]
    assert 'terminal_execute' in names and 'terminal_write' not in names and 'write_workspace_file' not in names
    stored = ctx.repository.load().commands[proposal['id']].result
    assert stored['terminal']['key_path'] == key
    server.homes.append(Path.home() / f"homun-{digest([actor.workspace_id, proposal['id']])[:32]}")
    agent_runs.approve(ctx, actor, work, proposal['id'], {
        'command_id': 'go', 'digest': proposal['digest'], 'expected_version': proposal['expected_version']})
    ctx.models.complete_tools = lambda *a, **k: SimpleNamespace(message=NativeMessage(
        role='assistant', tool_calls=[ToolCall(id='cmd1', name='terminal_execute', arguments={
            'command': 'pwd > where.txt; printf SENTINEL=%s "$SENTINEL" >> where.txt'})]), usage=None)
    assert advance(ctx, proposal['id']) == 'waiting_external'
    job = ctx.repository.load().commands[ctx.repository.load().commands[proposal['id']].result['terminal_request_id']].result
    assert job['policy'] == 'ssh-v1' and 'key_path' not in job and job['ssh_host'] == '127.0.0.1'
    terminal_jobs.approve(ctx, actor, work, job['id'], {'digest': job['digest']})
    resumed = False
    for _ in range(50):
        resumed = resume(ctx, proposal['id'])
        if resumed:
            break
        time.sleep(0.05)
    assert resumed
    text = (server.homes[-1] / 'where.txt').read_text()
    assert text.startswith(str(server.homes[-1])) and 'hidden-value' not in text


def test_ssh_stop_does_not_signal_another_session(server):
    jobs = SshJobs(server.root / "exec")
    first = spec(server, "a", "sleep 30")
    second = spec(server, "b", "sleep 30")
    jobs.start(first)
    jobs.start(second)
    assert jobs.stop(first)["running"] is False
    assert jobs.inspect(second)["running"] is True
    jobs.stop(second)
