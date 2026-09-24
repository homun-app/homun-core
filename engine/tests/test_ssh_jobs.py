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
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            self.port = probe.getsockname()[1]
        config = root / "sshd_config"
        config.write_text(
            f"Port {self.port}\nListenAddress 127.0.0.1\nHostKey {root / 'host'}\nPidFile {root / 'sshd.pid'}\n"
            f"AuthorizedKeysFile {root / 'client.pub'}\nPasswordAuthentication no\nKbdInteractiveAuthentication no\n"
            "UsePAM no\nStrictModes no\nPrintMotd no\n")
        self.process = subprocess.Popen(["/usr/sbin/sshd", "-f", str(config), "-E", str(root / "sshd.log"), "-D"])
        time.sleep(0.2)
        self.homes: list[Path] = []

    def close(self):
        self.process.terminate()
        try:
            self.process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            self.process.kill()
        for home in self.homes:
            shutil.rmtree(home, ignore_errors=True)


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
    from homun.application import agent_runs, terminal_jobs
    from homun.application.agent_run_execution import advance
    from homun.application.agent_terminal import resume
    from homun.execution.contracts import digest
    from homun.models.native_turn import NativeMessage, ToolCall
    monkeypatch.setenv('SENTINEL', 'hidden-value')
    ctx, actor, work, _ = setup
    ctx.models.set_active('openai_compatible')
    key = str(server.root / 'client')
    body = {'command_id': 'run', 'expected_version': 1, 'material_ids': [], 'terminal_backend': 'ssh',
            'ssh_host': '127.0.0.1', 'ssh_user': server.user, 'ssh_port': server.port,
            'ssh_host_key': server.host_key, 'ssh_key_path': key}
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
