#!/usr/bin/env python3
"""On-device speech-to-text server (faster-whisper), kept inside the contained
computer so it works identically on macOS/Windows/Linux (CPU, no cloud).

Design:
- The model is loaded LAZILY on the first /transcribe call and then kept WARM,
  so dictation after the first use is fast (no per-call reload).
- Multilingual: no fixed language — Whisper auto-detects (optional X-Language
  header hints it). large-v3-turbo by default (swappable via HOMUN_WHISPER_MODEL).
- The model weights download once to ~/.cache (a persistent Docker volume), so
  they survive container restarts.
"""
import json
import os
import tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MODEL_NAME = os.environ.get("HOMUN_WHISPER_MODEL", "large-v3-turbo")
PORT = int(os.environ.get("HOMUN_WHISPER_PORT", "9000"))

_model = None


def get_model():
    global _model
    if _model is None:
        from faster_whisper import WhisperModel

        # int8 on CPU: fastest + lowest memory, quality fine for dictation.
        _model = WhisperModel(MODEL_NAME, device="cpu", compute_type="int8")
    return _model


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def _json(self, code, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self._json(200, {"ok": True, "model": MODEL_NAME, "loaded": _model is not None})
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/transcribe":
            self._json(404, {"error": "not found"})
            return
        length = int(self.headers.get("Content-Length", "0") or "0")
        if length <= 0:
            self._json(400, {"error": "empty audio"})
            return
        data = self.rfile.read(length)
        language = self.headers.get("X-Language") or None
        try:
            with tempfile.NamedTemporaryFile(suffix=".audio", delete=True) as handle:
                handle.write(data)
                handle.flush()
                model = get_model()
                segments, info = model.transcribe(
                    handle.name,
                    language=language,
                    vad_filter=True,
                    beam_size=5,
                )
                text = "".join(segment.text for segment in segments).strip()
            self._json(200, {"text": text, "language": getattr(info, "language", None)})
        except Exception as error:  # noqa: BLE001 - surface to the gateway
            self._json(500, {"error": str(error)})


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
