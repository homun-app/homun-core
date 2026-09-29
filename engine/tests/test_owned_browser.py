"""The owned browser reads a public page and does not signal other processes."""
import subprocess
import time
from types import SimpleNamespace

from homun.application import agent_runs
from homun.application.agent_run_execution import advance
from homun.application.browser_form_pages import execute
from homun.execution.browser_forms import click, fill, open_page, snapshot
from homun.execution.browser_sessions import close_browser, open_browser
from homun.execution.browser_shots import capture
from homun.execution.owned_browser import OwnedBrowser, read_page
from homun.models.native_turn import NativeMessage, ToolCall
from test_agent_runs import setup


def test_private_page_does_not_start_a_browser(tmp_path):
    result = read_page(tmp_path / "browser", "http://127.0.0.1/secret")
    assert result["error_code"] == "web_address_refused"
    assert not (tmp_path / "browser").exists()


def test_owned_browser_reads_example_and_spares_another_process(tmp_path):
    sibling = subprocess.Popen(["/bin/sleep", "30"], start_new_session=True)
    try:
        result = read_page(tmp_path / "browser", "https://example.com/")
        assert "Example Domain" in result.get("text", "") or "documentation examples" in result.get("text", ""), result
        assert "Application Support/Google/Chrome" not in result.get("text", "")
        assert sibling.poll() is None
    finally:
        if sibling.poll() is None:
            sibling.terminate()
            sibling.wait(timeout=3)
        time.sleep(0.2)


def test_owned_browser_dismisses_a_native_dialog_without_accepting_it(tmp_path):
    browser = OwnedBrowser(tmp_path / "browser")
    try:
        page = browser._page_socket()
        page.call("Page.addScriptToEvaluateOnNewDocument", {"source": "confirm('homun-dialog-proof')"})
        result = browser.read("https://example.com/", dismiss_dialogs=True)
    finally:
        browser.close()
    assert "Example Domain" in result.get("text", "") or "documentation examples" in result.get("text", ""), result
    assert result.get("dialogs") == [{
        "type": "confirm", "message": "homun-dialog-proof", "action": "dismiss"}]


def test_approved_run_reads_in_an_owned_browser(setup):
    ctx, actor, work, _ = setup
    ctx.models.set_active("openai_compatible")
    proposal = agent_runs.propose(ctx, actor, work, {
        "command_id": "run", "expected_version": 1, "material_ids": [], "browser": True})
    assert proposal["browser"] == {"policy": "owned-headless-v1", "version": 5}
    names = [item["name"] for item in proposal["tools"]]
    assert "browser_open" in names and "browser_type" in names and "browser_screenshot" in names and "browser_read" not in names
    agent_runs.approve(ctx, actor, work, proposal["id"], {
        "command_id": "go", "digest": proposal["digest"], "expected_version": proposal["expected_version"]})
    ctx.models.complete_tools = lambda *a, **k: SimpleNamespace(message=NativeMessage(
        role="assistant", tool_calls=[ToolCall(
            id="b1", name="browser_open", arguments={"url": "https://example.com/"})]), usage=None)
    try:
        assert advance(ctx, proposal["id"]) == "running"
        text = str(ctx.repository.load().commands[proposal["id"]].result["observations"][-1]["result"])
        assert "Example Domain" in text or "documentation examples" in text
    finally:
        close_browser(proposal["id"])


def test_private_form_open_does_not_start_a_browser(tmp_path):
    result = execute(type("Ctx", (), {"data_dir": tmp_path})(), None, {
        "id": "run", "browser": {"policy": "owned-headless-v1", "version": 3},
    }, "browser_open", {"url": "http://127.0.0.1/secret"})
    assert result["error_code"] == "web_address_refused"
    assert not (tmp_path / "execution").exists()


def test_owned_browser_fills_a_public_field_and_clicks_its_button(tmp_path):
    browser = open_browser(tmp_path, "form-proof")
    try:
        browser._page_socket().call("Page.addScriptToEvaluateOnNewDocument", {"source": (
            "document.addEventListener('DOMContentLoaded', () => {"
            " const input = document.createElement('input');"
            " input.setAttribute('aria-label', 'Proof field');"
            " const button = document.createElement('button');"
            " button.type = 'button'; button.textContent = 'Proof button';"
            " button.addEventListener('click', () => document.body.setAttribute('data-proof', input.value));"
            " document.body.append(input, button); });"
        )})
        opened = open_page(browser, "https://example.com/")
        assert "Example Domain" in opened.get("text", "") or "documentation examples" in opened.get("text", ""), opened
        snapshot = opened.get("snapshot", "")
        field = next(line.split()[0] for line in snapshot.splitlines() if "Proof field" in line)
        button = next(line.split()[0] for line in snapshot.splitlines() if "Proof button" in line)
        typed = fill(browser, field, "homun-form-proof")
        assert typed.get("typed") is True and "homun-form-proof" not in str(typed), typed
        clicked = click(browser, button)
        assert clicked.get("clicked") == button, clicked
        value = browser._page_socket().call(
            "Runtime.evaluate",
            {"expression": "document.body.getAttribute('data-proof')", "returnByValue": True})
        assert ((value.get("result") or {}).get("result") or {}).get("value") == "homun-form-proof"
    finally:
        close_browser("form-proof")


def test_owned_browser_saves_a_png_of_the_public_page(tmp_path):
    browser = open_browser(tmp_path, "shot-proof")
    dest = tmp_path / "shots" / "page.png"
    try:
        opened = open_page(browser, "https://example.com/")
        assert "Example Domain" in opened.get("text", "") or "documentation examples" in opened.get("text", ""), opened
        shot = capture(browser, dest)
        assert shot.get("url", "").startswith("https://example.com"), shot
        raw = dest.read_bytes()
        assert raw.startswith(b"\x89PNG\r\n\x1a\n")
        assert shot["bytes"] == len(raw) and shot["width"] >= 100 and shot["height"] >= 100
        assert "execution/browsers" not in shot["path"]
    finally:
        close_browser("shot-proof")
    assert dest.is_file()
    assert not (tmp_path / "execution" / "browsers" / "shot-proof").exists()


def test_owned_browser_interacts_inside_iframe(tmp_path):
    browser = open_browser(tmp_path, "iframe-proof")
    browser.include_frames = True
    try:
        browser._page_socket().call("Page.addScriptToEvaluateOnNewDocument", {"source": (
            "if (window.self === window.top) {"
            " document.addEventListener('DOMContentLoaded', () => {"
            "  const frame = document.createElement('iframe');"
            "  document.body.appendChild(frame);"
            "  frame.contentDocument.body.innerHTML = '<input aria-label=\"Frame field\"><button type=\"button\">Frame button</button>';"
            "  frame.contentDocument.querySelector('button').addEventListener('click', () => {"
            "   frame.contentDocument.body.setAttribute('data-clicked', 'yes');"
            "  });"
            " });"
            "}"
        )})
        opened = open_page(browser, "https://example.com/")
        assert "Example Domain" in opened.get("text", "") or "documentation examples" in opened.get("text", ""), opened
        snapshot = opened.get("snapshot", "")
        field = next(line.split()[0] for line in snapshot.splitlines() if "Frame field" in line)
        button = next(line.split()[0] for line in snapshot.splitlines() if "Frame button" in line)
        typed = fill(browser, field, "homun-frame-value")
        assert typed.get("typed") is True
        clicked = click(browser, button)
        assert clicked.get("clicked") == button
        val = browser._page_socket().call(
            "Runtime.evaluate",
            {"expression": "document.querySelector('iframe').contentDocument.body.getAttribute('data-clicked')", "returnByValue": True})
        assert ((val.get("result") or {}).get("result") or {}).get("value") == "yes"
        input_val = browser._page_socket().call(
            "Runtime.evaluate",
            {"expression": "document.querySelector('iframe').contentDocument.querySelector('input').value", "returnByValue": True})
        assert ((input_val.get("result") or {}).get("result") or {}).get("value") == "homun-frame-value"
    finally:
        close_browser("iframe-proof")


def test_version_5_populates_iframe_and_version_4_ignores_it(tmp_path):
    browser = open_browser(tmp_path, "v4-v5-proof")
    try:
        browser._page_socket().call("Page.addScriptToEvaluateOnNewDocument", {"source": (
            "if (window.self === window.top) {"
            " document.addEventListener('DOMContentLoaded', () => {"
            "  const frame = document.createElement('iframe');"
            "  document.body.appendChild(frame);"
            "  frame.contentDocument.body.innerHTML = '<button type=\"button\">V5 Button</button>';"
            " });"
            "}"
        )})
        browser.include_frames = False
        res_v4 = open_page(browser, "https://example.com/")
        assert "V5 Button" not in res_v4.get("snapshot", "")
        browser.include_frames = True
        res_v5 = snapshot(browser)
        assert "V5 Button" in res_v5.get("snapshot", "")
    finally:
        close_browser("v4-v5-proof")


def test_owned_browser_accepts_native_dialog_and_collects_console_logs(tmp_path):
    browser = OwnedBrowser(tmp_path / "browser")
    try:
        page = browser._page_socket()
        page.call("Page.addScriptToEvaluateOnNewDocument", {"source": "console.log('homun-console-msg'); prompt('Enter code:', 'initial');"})
        result = browser.read("https://example.com/", accept_dialogs=True, prompt_text="homun-code-42")
        logs = browser.get_console_logs()
    finally:
        browser.close()
    assert any(d.get("action") == "accept" for d in result.get("dialogs", []))
    assert any("homun-console-msg" in log.get("text", "") for log in logs)

