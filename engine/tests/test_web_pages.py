"""Public pages can be read. Private listeners and missing search stay closed."""
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from homun.execution.web_pages import fetch_page, search_hits, search_public, visible_text
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


def test_search_hits_drop_private_urls():
    page = b'''<a class="result__a" href="http://127.0.0.1/secret">Local</a>
<a class="result__snippet" href="http://127.0.0.1/secret">hidden</a>
<a class="result__a" href="https://example.com/">Example Domain</a>
<a class="result__snippet" href="https://example.com/">documentation name</a>'''
    hits = search_hits(page)
    assert hits == [{"url": "https://example.com/", "title": "Example Domain", "snippet": "documentation name"}]


def test_public_search_returns_example_domain():
    result = search_public("example.com")
    assert result.get("results") or result.get("error_code") in {"web_fetch_failed", "web_query_refused"}, result


def test_web_search_returns_public_results(setup):
    from types import SimpleNamespace
    from homun.application import agent_runs
    from homun.application.agent_run_execution import advance
    from homun.models.native_turn import NativeMessage, ToolCall
    ctx, actor, work, _ = setup
    ctx.models.set_active("openai_compatible")
    proposal = agent_runs.propose(ctx, actor, work, {
        "command_id": "run", "expected_version": 1, "material_ids": [], "web_pages": True})
    names = [item["name"] for item in proposal["tools"]]
    assert proposal["web_pages"] == {"policy": "public-http-v1", "version": 3}
    assert "web_extract" in names and "web_search" in names and "x_search" in names
    agent_runs.approve(ctx, actor, work, proposal["id"], {
        "command_id": "go", "digest": proposal["digest"], "expected_version": proposal["expected_version"]})
    ctx.models.complete_tools = lambda *a, **k: SimpleNamespace(message=NativeMessage(
        role="assistant", tool_calls=[ToolCall(id="q1", name="web_search", arguments={"query": "example domain"})]), usage=None)
    assert advance(ctx, proposal["id"]) == "running"
    observation = ctx.repository.load().commands[proposal["id"]].result["observations"][-1]
    res = observation["result"]
    assert res.get("results") or res.get("error_code") in (
        "web_fetch_failed", "web_query_refused", "web_provider_unavailable"), res


def test_web_cache_and_query_normalization():
    from homun.execution.web_cache import WebCache, normalize_query, normalize_url
    assert normalize_query("  Example   Query  ") == "example query"
    assert normalize_url("https://Example.COM:443/test/?q=1") == "https://example.com/test/?q=1"
    assert normalize_url("http://example.com:80/") == "http://example.com/"

    cache = WebCache(ttl_seconds=60)
    assert cache.get_search("duckduckgo-html", "foo bar") is None
    cache.put_search("duckduckgo-html", "  FOO   bar  ", {"results": [{"url": "https://example.com"}]})
    hit = cache.get_search("duckduckgo-html", "foo bar")
    assert hit == {"results": [{"url": "https://example.com"}]}

    # Error responses are never cached
    cache.put_search("duckduckgo-html", "error query", {"error_code": "web_fetch_failed"})
    assert cache.get_search("duckduckgo-html", "error query") is None

    # URL extract cache
    assert cache.get_extract("https://example.com") is None
    cache.put_extract("https://example.com", {"status": 200, "text": "hello"})
    assert cache.get_extract("https://example.com:443/") == {"status": 200, "text": "hello"}


def test_cached_fetch_page_serves_from_cache():
    from homun.execution.web_cache import WebCache, cached_fetch_page
    cache = WebCache(ttl_seconds=60)
    cache.put_extract("https://example.com/", {"status": 200, "text": "hello", "truncated": False})
    res = cached_fetch_page("https://example.com/", cache=cache)
    assert res.get("cached") is True
    assert res.get("text") == "hello"


def test_named_provider_credential_validation():
    import os
    from homun.execution.web_providers import execute_provider_search
    # Ensure env key is not set
    old_val = os.environ.pop("BRAVE_API_KEY", None)
    try:
        res = execute_provider_search("brave", "test query")
        assert res["error_code"] == "web_provider_credentials_missing"
        assert "BRAVE_API_KEY" in res["message"]
    finally:
        if old_val is not None:
            os.environ["BRAVE_API_KEY"] = old_val

    res = execute_provider_search("unknown_engine", "test query")
    assert res["error_code"] == "web_provider_unavailable"


def test_search_with_rescue_triggers_fallback_and_is_not_cached(monkeypatch):
    from homun.execution.web_cache import WebCache
    from homun.execution import web_providers

    cache = WebCache(ttl_seconds=60)
    # Simulate a provider fetch failure (e.g. 503 from backend API)
    monkeypatch.setattr(
        web_providers,
        "execute_provider_search",
        lambda provider, query, limit=5: {"error_code": "web_fetch_failed", "message": "503 Backend Offline"},
    )
    monkeypatch.setattr(
        web_providers,
        "search_public",
        lambda query: {"results": [{"url": "https://example.com/item", "title": "Example", "snippet": "..."}]},
    )

    res = web_providers.search_with_rescue("example domain", provider="brave", cache=cache)
    assert res.get("rescued_from") == "brave"
    assert "Configured backend 'brave' failed" in res.get("backend_error", "")
    assert any("example.com" in hit["url"] for hit in res.get("results", []))

    # Hermes invariant: rescue results must NEVER be cached
    assert cache.get_search("brave", "example domain") is None


def test_x_search_validation_and_credentials():
    import os
    from homun.execution.x_search import search_x

    # Query validation
    assert search_x("")["error_code"] == "web_query_refused"
    assert search_x("line1\nline2")["error_code"] == "web_query_refused"

    # Handles count validation
    handles = [f"user{i}" for i in range(12)]
    assert search_x("news", allowed_handles=handles)["error_code"] == "web_query_refused"

    # Date format validation
    assert search_x("news", from_date="not-a-date")["error_code"] == "web_query_refused"
    assert search_x("news", from_date="2026/01/01")["error_code"] == "web_query_refused"

    # Credential check
    old_key = os.environ.pop("XAI_API_KEY", None)
    try:
        res = search_x("news", from_date="2026-01-01")
        assert res["error_code"] == "web_provider_credentials_missing"
        assert "XAI_API_KEY" in res["message"]
    finally:
        if old_key is not None:
            os.environ["XAI_API_KEY"] = old_key


def test_exa_firecrawl_searxng_providers(monkeypatch):
    import io
    import json
    import os
    import urllib.request
    from homun.execution.web_providers import execute_provider_search

    # 1. Missing credentials
    old_exa = os.environ.pop("EXA_API_KEY", None)
    old_fc = os.environ.pop("FIRECRAWL_API_KEY", None)
    old_sx = os.environ.pop("SEARXNG_URL", None)
    try:
        assert execute_provider_search("exa", "test")["error_code"] == "web_provider_credentials_missing"
        assert execute_provider_search("firecrawl", "test")["error_code"] == "web_provider_credentials_missing"
        assert execute_provider_search("searxng", "test")["error_code"] == "web_provider_credentials_missing"

        # 2. Exa mock with private IP filtering
        os.environ["EXA_API_KEY"] = "fake-exa-key"
        exa_response_data = json.dumps({
            "results": [
                {"url": "https://example.com/article", "title": "Example", "text": "Snippet text"},
                {"url": "http://127.0.0.1/private", "title": "Evil", "text": "Private"},
            ]
        }).encode("utf-8")

        class MockResp:
            def __init__(self, data):
                self._data = data
            def read(self):
                return self._data
            def __enter__(self):
                return self
            def __exit__(self, *args):
                pass

        monkeypatch.setattr(urllib.request, "urlopen", lambda req, timeout=15: MockResp(exa_response_data))
        res_exa = execute_provider_search("exa", "quantum")
        assert res_exa["provider"] == "exa"
        assert len(res_exa["results"]) == 1
        assert res_exa["results"][0]["url"] == "https://example.com/article"

        # 3. Firecrawl mock
        os.environ["FIRECRAWL_API_KEY"] = "fake-fc-key"
        fc_response_data = json.dumps({
            "data": [
                {"url": "https://example.com/firecrawl", "title": "FC Test", "description": "FC snippet"}
            ]
        }).encode("utf-8")
        monkeypatch.setattr(urllib.request, "urlopen", lambda req, timeout=15: MockResp(fc_response_data))
        res_fc = execute_provider_search("firecrawl", "web search")
        assert res_fc["provider"] == "firecrawl"
        assert len(res_fc["results"]) == 1
        assert res_fc["results"][0]["url"] == "https://example.com/firecrawl"

        # 4. SearXNG mock
        os.environ["SEARXNG_URL"] = "https://example.com"
        sx_response_data = json.dumps({
            "results": [
                {"url": "https://example.com/searxng", "title": "SearX Result", "content": "SearX snippet"}
            ]
        }).encode("utf-8")
        monkeypatch.setattr(urllib.request, "urlopen", lambda req, timeout=15: MockResp(sx_response_data))
        res_sx = execute_provider_search("searxng", "open source")
        assert res_sx["provider"] == "searxng"
        assert len(res_sx["results"]) == 1
        assert res_sx["results"][0]["url"] == "https://example.com/searxng"
    finally:
        if old_exa is not None:
            os.environ["EXA_API_KEY"] = old_exa
        else:
            os.environ.pop("EXA_API_KEY", None)
        if old_fc is not None:
            os.environ["FIRECRAWL_API_KEY"] = old_fc
        else:
            os.environ.pop("FIRECRAWL_API_KEY", None)
        if old_sx is not None:
            os.environ["SEARXNG_URL"] = old_sx
        else:
            os.environ.pop("SEARXNG_URL", None)


