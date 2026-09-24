"""Public pages can be read. Private listeners and missing search stay closed."""
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from homun.execution.web_pages import fetch_page, visible_text
from test_agent_runs import setup


def test_visible_text_drops_scripts():
    raw = b"<html><style>hidden</style><h1>Title</h1><script>secret()</script><p>Body</p></html>"
    assert visible_text(raw, "text/html") == "Title\nBody"


def test_private_listener_is_not_contacted():
    hits = []

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            hits.append(self.path)
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"secret")

        def log_message(self, format, *args):
            return None

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        port = server.server_address[1]
        result = fetch_page(f"http://127.0.0.1:{port}/secret")
    finally:
        server.shutdown()
        thread.join(timeout=2)
    assert result["error_code"] == "web_address_refused"
    assert hits == []


def test_credential_urls_are_refused():
    assert fetch_page("https://user:secret@example.com/")["error_code"] == "web_url_refused"
    assert fetch_page("https://example.com/?token=abc")["error_code"] == "web_url_refused"
    assert fetch_page("http://169.254.169.254/latest")["error_code"] == "web_address_refused"
    assert fetch_page("http://metadata.google.internal/")["error_code"] == "web_address_refused"


def test_example_page_is_readable():
    result = fetch_page("https://example.com/")
    assert result["status"] == 200, result
    assert "Example Domain" in result["text"]
    assert result["truncated"] is False


def test_web_search_reports_that_no_provider_is_configured(setup):
    from types import SimpleNamespace
    from homun.application import agent_runs
    from homun.application.agent_run_execution import advance
    from homun.models.native_turn import NativeMessage, ToolCall
    ctx, actor, work, _ = setup
    ctx.models.set_active("openai_compatible")
    proposal = agent_runs.propose(ctx, actor, work, {
        "command_id": "run", "expected_version": 1, "material_ids": [], "web_pages": True})
    names = [item["name"] for item in proposal["tools"]]
    assert proposal["web_pages"] == {"policy": "public-http-v1", "version": 1}
    assert "web_extract" in names and "web_search" in names
    agent_runs.approve(ctx, actor, work, proposal["id"], {
        "command_id": "go", "digest": proposal["digest"], "expected_version": proposal["expected_version"]})
    ctx.models.complete_tools = lambda *a, **k: SimpleNamespace(message=NativeMessage(
        role="assistant", tool_calls=[ToolCall(id="q1", name="web_search", arguments={"query": "example"})]), usage=None)
    assert advance(ctx, proposal["id"]) == "running"
    observation = ctx.repository.load().commands[proposal["id"]].result["observations"][-1]
    assert observation["result"]["error_code"] == "web_provider_unavailable"
