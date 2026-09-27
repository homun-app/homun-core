"""Tests for D2a/H14 web provider protocols and dispatching."""
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
from homun.execution import web_providers


class MockProviderServer:
    def __init__(self):
        self.requests = []
        self.handler_fn = None
        self.server = None
        self.thread = None

    def start(self, handler_fn):
        self.handler_fn = handler_fn
        parent = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                length = int(self.headers.get("Content-Length", 0))
                body = self.rfile.read(length) if length > 0 else b""
                parent.requests.append({
                    "method": "POST",
                    "path": self.path,
                    "headers": dict(self.headers),
                    "body": body,
                })
                status, resp_headers, resp_body = parent.handler_fn(
                    "POST", self.path, dict(self.headers), body
                )
                self.send_response(status)
                for k, v in resp_headers.items():
                    self.send_header(k, v)
                self.end_headers()
                self.wfile.write(resp_body)

            def do_GET(self):
                parent.requests.append({
                    "method": "GET",
                    "path": self.path,
                    "headers": dict(self.headers),
                    "body": b"",
                })
                status, resp_headers, resp_body = parent.handler_fn(
                    "GET", self.path, dict(self.headers), b""
                )
                self.send_response(status)
                for k, v in resp_headers.items():
                    self.send_header(k, v)
                self.end_headers()
                self.wfile.write(resp_body)

            def log_message(self, format, *args):
                return None

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        port = self.server.server_address[1]
        return f"http://127.0.0.1:{port}"

    def stop(self):
        if self.server:
            self.server.shutdown()
        if self.thread:
            self.thread.join(timeout=2)


@pytest.fixture
def mock_server():
    server = MockProviderServer()
    yield server
    server.stop()


def test_perplexity_provider_search(mock_server, monkeypatch):
    def handle_perplexity(method, path, headers, body):
        assert method == "POST"
        assert path == "/search"
        assert "Bearer test-pplx-key" in headers.get("Authorization", "")
        payload = json.loads(body.decode("utf-8"))
        assert payload["query"] == "quantum computing"
        assert payload["max_results"] == 3
        assert payload["search_context_size"] == "low"
        resp = {
            "results": [
                {"url": "https://example.com/quantum", "title": "Quantum Intro", "snippet": "About qubits"},
                {"url": "http://127.0.0.1/private", "title": "Loopback", "snippet": "Hidden"},
            ]
        }
        return 200, {"Content-Type": "application/json"}, json.dumps(resp).encode("utf-8")

    base_url = mock_server.start(handle_perplexity)
    monkeypatch.setenv("PERPLEXITY_BASE_URL", base_url)
    monkeypatch.setenv("PERPLEXITY_API_KEY", "test-pplx-key")

    res = web_providers.execute_provider_search("perplexity", "quantum computing", limit=3)
    assert res["provider"] == "perplexity"
    assert len(res["results"]) == 1
    assert res["results"][0]["url"] == "https://example.com/quantum"
    assert res["results"][0]["title"] == "Quantum Intro"


def test_perplexity_citations_fallback(mock_server, monkeypatch):
    def handle_perplexity(method, path, headers, body):
        resp = {
            "citations": ["https://example.com/cite1", "https://example.com/cite2", "http://127.0.0.1/private"]
        }
        return 200, {"Content-Type": "application/json"}, json.dumps(resp).encode("utf-8")

    base_url = mock_server.start(handle_perplexity)
    monkeypatch.setenv("PERPLEXITY_BASE_URL", base_url)
    monkeypatch.setenv("PERPLEXITY_API_KEY", "test-pplx-key")

    res = web_providers.execute_provider_search("perplexity", "cite query")
    assert res["provider"] == "perplexity"
    assert len(res["results"]) == 2
    assert res["results"][0]["url"] == "https://example.com/cite1"
    assert res["results"][1]["url"] == "https://example.com/cite2"


def test_xai_provider_search(mock_server, monkeypatch):
    def handle_xai(method, path, headers, body):
        assert method == "POST"
        assert path == "/responses"
        assert "Bearer test-xai-key" in headers.get("Authorization", "")
        payload = json.loads(body.decode("utf-8"))
        assert payload["model"] == "grok-build-0.1"
        assert payload["tools"] == [{"type": "web_search"}]
        # Response has structured output in message
        mock_output = json.dumps({
            "results": [
                {"url": "https://example.com/ai", "title": "Grok AI", "snippet": "Frontier intelligence"},
                {"url": "http://192.168.1.1/secret", "title": "Internal", "snippet": "Forbidden"},
            ]
        })
        resp = {
            "output": [
                {"message": {"content": mock_output}}
            ]
        }
        return 200, {"Content-Type": "application/json"}, json.dumps(resp).encode("utf-8")

    base_url = mock_server.start(handle_xai)
    monkeypatch.setenv("XAI_BASE_URL", base_url)
    monkeypatch.setenv("XAI_API_KEY", "test-xai-key")

    res = web_providers.execute_provider_search("xai", "grok latest news")
    assert res["provider"] == "xai"
    assert len(res["results"]) == 1
    assert res["results"][0]["url"] == "https://example.com/ai"
    assert res["results"][0]["title"] == "Grok AI"


def test_parallel_provider_search_and_extract(mock_server, monkeypatch):
    def handle_parallel(method, path, headers, body):
        assert "Bearer test-parallel-key" in headers.get("Authorization", "")
        if path == "/v1beta/search":
            payload = json.loads(body.decode("utf-8"))
            assert payload["objective"] == "parallel web"
            assert payload["search_queries"] == ["parallel web"]
            resp = {
                "results": [
                    {"url": "https://example.com/parallel", "title": "Parallel Search", "excerpts": ["Fast web API", "Snippet"]}
                ]
            }
            return 200, {"Content-Type": "application/json"}, json.dumps(resp).encode("utf-8")
        elif path == "/v1beta/extract":
            payload = json.loads(body.decode("utf-8"))
            assert payload["urls"] == ["https://example.com/parallel"]
            resp = {
                "results": [
                    {"url": "https://example.com/parallel", "text": "Extracted parallel content", "title": "Parallel Title"}
                ]
            }
            return 200, {"Content-Type": "application/json"}, json.dumps(resp).encode("utf-8")
        return 404, {}, b""

    base_url = mock_server.start(handle_parallel)
    monkeypatch.setenv("PARALLEL_BASE_URL", base_url)
    monkeypatch.setenv("PARALLEL_API_KEY", "test-parallel-key")

    # Search
    s_res = web_providers.execute_provider_search("parallel", "parallel web")
    assert s_res["provider"] == "parallel"
    assert len(s_res["results"]) == 1
    assert s_res["results"][0]["url"] == "https://example.com/parallel"
    assert "Fast web API Snippet" in s_res["results"][0]["snippet"]

    # Extract
    e_res = web_providers.execute_provider_extract("https://example.com/parallel", provider="parallel")
    assert e_res["status"] == 200
    assert e_res["text"] == "Extracted parallel content"


def test_keenable_provider_search_and_extract(mock_server, monkeypatch):
    def handle_keenable(method, path, headers, body):
        if path == "/v1/search":
            payload = json.loads(body.decode("utf-8"))
            assert payload["query"] == "keenable search"
            resp = {
                "results": [
                    {"url": "https://example.com/keenable", "title": "Keenable Engine", "snippet": "Web results"}
                ]
            }
            return 200, {"Content-Type": "application/json"}, json.dumps(resp).encode("utf-8")
        elif path.startswith("/v1/fetch"):
            assert "example.com/keenable" in path
            resp = {
                "text": "Keenable fetched markdown body",
                "title": "Keenable Article"
            }
            return 200, {"Content-Type": "application/json"}, json.dumps(resp).encode("utf-8")
        return 404, {}, b""

    base_url = mock_server.start(handle_keenable)
    monkeypatch.setenv("KEENABLE_BASE_URL", base_url)
    monkeypatch.delenv("KEENABLE_API_KEY", raising=False)

    # Search keyless (uses X-Keenable-Title: homun-engine)
    s_res = web_providers.execute_provider_search("keenable", "keenable search")
    assert s_res["provider"] == "keenable"
    assert len(s_res["results"]) == 1
    assert s_res["results"][0]["url"] == "https://example.com/keenable"

    # Extract
    e_res = web_providers.execute_provider_extract("https://example.com/keenable", provider="keenable")
    assert e_res["status"] == 200
    assert e_res["text"] == "Keenable fetched markdown body"


def test_openai_native_is_unsupported():
    res = web_providers.execute_provider_search("openai-native", "some query")
    assert res["error_code"] == "web_provider_unsupported"
    assert "openai-native" in res["message"]


def test_missing_credentials_reported_cleanly(monkeypatch):
    monkeypatch.delenv("PERPLEXITY_API_KEY", raising=False)
    res = web_providers.execute_provider_search("perplexity", "query")
    assert res["error_code"] == "web_provider_credentials_missing"
    assert "PERPLEXITY_API_KEY" in res["message"]

    monkeypatch.delenv("PARALLEL_API_KEY", raising=False)
    res2 = web_providers.execute_provider_search("parallel", "query")
    assert res2["error_code"] == "web_provider_credentials_missing"
    assert "PARALLEL_API_KEY" in res2["message"]


def test_extract_unsupported_provider():
    res = web_providers.execute_provider_extract("https://example.com", provider="searxng")
    assert res["error_code"] == "web_provider_unsupported"
    assert "searxng" in res["message"]
