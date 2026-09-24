"""The owned browser reads a public page and does not signal other processes."""
import subprocess
import time

from homun.execution.owned_browser import read_page
from test_agent_runs import setup


def test_private_page_does_not_start_a_browser(tmp_path):
    result = read_page(tmp_path / "browser", "http://127.0.0.1/secret")
    assert result["error_code"] == "web_address_refused"
    assert not (tmp_path / "browser").exists()


def test_owned_browser_reads_example_and_spares_another_process(tmp_path):
    sibling = subprocess.Popen(["/bin/sleep", "30"], start_new_session=True)
    try:
        result = read_page(tmp_path / "browser", "https://example.com/")
        assert "Example Domain" in result.get("text", ""), result
        assert "Application Support/Google/Chrome" not in result.get("text", "")
        assert sibling.poll() is None
    finally:
        if sibling.poll() is None:
            sibling.terminate()
            sibling.wait(timeout=3)
        time.sleep(0.2)


def test_approved_run_reads_in_an_owned_browser(setup):
    from types import SimpleNamespace
    from homun.application import agent_runs
    from homun.application.agent_run_execution import advance
    from homun.models.native_turn import NativeMessage, ToolCall
    ctx, actor, work, _ = setup
    ctx.models.set_active("openai_compatible")
    proposal = agent_runs.propose(ctx, actor, work, {
        "command_id": "run", "expected_version": 1, "material_ids": [], "browser": True})
    assert proposal["browser"] == {"policy": "owned-headless-v1", "version": 1}
    assert "browser_read" in [item["name"] for item in proposal["tools"]]
    agent_runs.approve(ctx, actor, work, proposal["id"], {
        "command_id": "go", "digest": proposal["digest"], "expected_version": proposal["expected_version"]})
    ctx.models.complete_tools = lambda *a, **k: SimpleNamespace(message=NativeMessage(
        role="assistant", tool_calls=[ToolCall(
            id="b1", name="browser_read", arguments={"url": "https://example.com/"})]), usage=None)
    assert advance(ctx, proposal["id"]) == "running"
    text = str(ctx.repository.load().commands[proposal["id"]].result["observations"][-1]["result"])
    assert "Example Domain" in text
