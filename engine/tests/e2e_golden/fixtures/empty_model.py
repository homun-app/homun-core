"""Un «modello» OpenAI-compatibile che risponde sempre vuoto (scenario A6).

Il motore gira come processo vero: per provocare una risposta vuota del
modello non si può monkeypatchare nulla. Questo stub ascolta su una porta
libera di loopback e risponde a `POST /v1/chat/completions` con un messaggio
dell'assistente senza testo e senza chiamate di strumenti, con i contatori
d'uso riportati. La porta non è 11434: il motore lo tratta come endpoint
OpenAI-compatibile, non come Ollama.
"""
from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

EMPTY_MODEL_ID = "sempre-vuoto"


class _EmptyHandler(BaseHTTPRequestHandler):
    server_version = "GoldenEmptyModel/1.0"

    def log_message(self, format, *args):  # noqa: A002 — firma di BaseHTTPRequestHandler
        return  # silenzioso: niente rumore nei log della suite

    def do_POST(self):  # noqa: N802 — nome imposto da BaseHTTPRequestHandler
        length = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(length) or b"{}") if length else {}
        self.server.requests.append(body)  # type: ignore[attr-defined]
        payload = {
            "id": "chatcmpl-golden-empty",
            "object": "chat.completion",
            "model": body.get("model") or EMPTY_MODEL_ID,
            "choices": [{"index": 0, "finish_reason": "stop",
                         "message": {"role": "assistant", "content": ""}}],
            "usage": {"prompt_tokens": 12, "completion_tokens": 0, "total_tokens": 12},
        }
        self._json(200, payload)

    def do_GET(self):  # noqa: N802
        if self.path.rstrip("/").endswith("/models"):
            self._json(200, {"object": "list", "data": [{"id": EMPTY_MODEL_ID, "object": "model"}]})
            return
        self._json(404, {"error": {"message": "not found"}})

    def _json(self, status: int, payload: dict) -> None:
        raw = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)


class EmptyModelServer:
    """Avvia e ferma lo stub; `base_url` è quello da dare alla connessione."""

    def __init__(self) -> None:
        self._server = ThreadingHTTPServer(("127.0.0.1", 0), _EmptyHandler)
        self._server.requests = []  # type: ignore[attr-defined]
        self._thread = threading.Thread(target=self._server.serve_forever, name="golden-empty-model", daemon=True)

    @property
    def base_url(self) -> str:
        host, port = self._server.server_address[:2]
        return f"http://{host}:{port}/v1"

    @property
    def requests(self) -> list[dict]:
        return list(self._server.requests)  # type: ignore[attr-defined]

    def __enter__(self) -> EmptyModelServer:
        self._thread.start()
        return self

    def __exit__(self, *exc) -> None:
        self._server.shutdown()
        self._server.server_close()
