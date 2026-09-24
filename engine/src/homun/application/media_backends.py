"""Real media backends for vision and TTS (H41).

Ollama vision uses the local OpenAI-compatible API when available.
macOS `say` synthesizes AIFF audio to a durable artifact directory.
These backends never invent success: missing host/binary/model returns errors.
"""
from __future__ import annotations

import base64
import json
import logging
import os
import shutil
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from homun.storage.paths import default_data_dir

logger = logging.getLogger(__name__)

DEFAULT_OLLAMA_BASE = "http://127.0.0.1:11434"
DEFAULT_VISION_MODELS = (
    "gemma4:latest",
    "gemma4:12b",
    "qwen3.5:4b",
    "qwen3-vl:235b-cloud",
)


def ollama_base_url() -> str:
    return (os.environ.get("HOMUN_OLLAMA_BASE") or os.environ.get("OLLAMA_HOST") or DEFAULT_OLLAMA_BASE).rstrip("/")


def media_artifact_dir() -> Path:
    root = default_data_dir() / "media" / "artifacts"
    root.mkdir(parents=True, exist_ok=True)
    return root


def _http_json(method: str, url: str, payload: Optional[Dict[str, Any]] = None, timeout: float = 120.0) -> Dict[str, Any]:
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers={"Content-Type": "application/json", "Accept": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        body = resp.read().decode("utf-8")
        return json.loads(body) if body else {}


def list_ollama_models(base: Optional[str] = None) -> List[str]:
    base = (base or ollama_base_url()).rstrip("/")
    try:
        payload = _http_json("GET", f"{base}/api/tags", timeout=5.0)
    except Exception as exc:
        logger.debug("Ollama tags probe failed: %s", exc)
        return []
    models = payload.get("models") or []
    return [str(m.get("name") or "") for m in models if m.get("name")]


def resolve_ollama_vision_model(preferred: Optional[str] = None, base: Optional[str] = None) -> Optional[str]:
    env_model = os.environ.get("HOMUN_VISION_MODEL") or preferred
    available = set(list_ollama_models(base))
    if not available:
        return None
    if env_model and env_model in available:
        return env_model
    for name in DEFAULT_VISION_MODELS:
        if name in available:
            return name
    # Prefer any local model that advertises vision via /api/show when cheap to check.
    for name in sorted(available):
        if "vl" in name.lower() or "vision" in name.lower() or name.startswith("gemma4"):
            return name
    return None


def ollama_vision_dispatcher(
    *,
    model: Optional[str] = None,
    base: Optional[str] = None,
) -> Callable[[str, str, str], Dict[str, Any]]:
    """Return a VisionAnalyzer backend_dispatcher backed by Ollama chat."""

    base_url = (base or ollama_base_url()).rstrip("/")
    chosen = resolve_ollama_vision_model(model, base=base_url)
    if not chosen:
        raise RuntimeError(
            "No Ollama vision model is available. Set HOMUN_VISION_MODEL or pull a vision-capable model."
        )

    def _dispatch(normalized_src: str, mime: str, prompt: str) -> Dict[str, Any]:
        # Ollama accepts images as raw base64 without the data: prefix.
        if normalized_src.startswith("data:"):
            b64 = normalized_src.split(",", 1)[-1]
        elif normalized_src.startswith("http://") or normalized_src.startswith("https://"):
            raise RuntimeError(
                "Remote image URLs require a fetch backend; pass a local file or data URI for Ollama vision."
            )
        else:
            b64 = base64.b64encode(Path(normalized_src).read_bytes()).decode("ascii")

        payload = {
            "model": chosen,
            "stream": False,
            "messages": [
                {
                    "role": "user",
                    "content": prompt,
                    "images": [b64],
                }
            ],
        }
        result = _http_json("POST", f"{base_url}/api/chat", payload, timeout=180.0)
        message = result.get("message") or {}
        text = str(message.get("content") or "").strip()
        if not text:
            raise RuntimeError("Ollama vision returned an empty description.")
        eval_count = int((result.get("eval_count") or 0) or 0)
        prompt_eval = int((result.get("prompt_eval_count") or 0) or 0)
        return {
            "text": text,
            "tokens": eval_count + prompt_eval,
            "metadata": {
                "provider": "ollama",
                "model": chosen,
                "mime": mime,
                "eval_count": eval_count,
                "prompt_eval_count": prompt_eval,
            },
        }

    return _dispatch


def macos_say_available() -> bool:
    return shutil.which("say") is not None


def macos_say_tts_dispatcher() -> Callable[[str, Dict[str, Any]], Dict[str, Any]]:
    """Return a TTS backend_dispatcher using macOS `say` (AIFF)."""

    if not macos_say_available():
        raise RuntimeError("macOS say binary is not available on PATH.")

    def _dispatch(provider: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        text = str(payload.get("text") or "").strip()
        if not text:
            raise RuntimeError("Empty text for TTS.")
        voice = payload.get("voice")
        out_dir = media_artifact_dir()
        stamp = int(time.time() * 1000)
        out_path = out_dir / f"tts-say-{stamp}.aiff"
        cmd = ["say", "-o", str(out_path)]
        if voice and str(voice).strip() and not str(voice).endswith("Neural"):
            # Neural voices are Edge-TTS names; ignore for say.
            cmd.extend(["-v", str(voice)])
        cmd.append(text)
        completed = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
        if completed.returncode != 0 or not out_path.is_file() or out_path.stat().st_size <= 0:
            err = (completed.stderr or completed.stdout or "say failed").strip()
            raise RuntimeError(err)
        # Approximate duration from file size when afinfo is unavailable.
        duration = max(0.1, out_path.stat().st_size / 44100.0)
        return {
            "audio_url": out_path.resolve().as_uri(),
            "duration": duration,
            "metadata": {
                "provider": "macos_say",
                "requested_provider": provider,
                "path": str(out_path.resolve()),
                "format": "aiff",
            },
        }

    return _dispatch


def resolve_vision_dispatcher(
    *,
    model: Optional[str] = None,
) -> Optional[Callable[[str, str, str], Dict[str, Any]]]:
    """Auto-resolve a vision backend when Ollama is reachable; else None."""
    try:
        return ollama_vision_dispatcher(model=model)
    except Exception as exc:
        logger.info("Vision backend unavailable: %s", exc)
        return None


def resolve_tts_dispatcher(provider: Optional[str] = None) -> Optional[Callable[[str, Dict[str, Any]], Dict[str, Any]]]:
    """Auto-resolve TTS: macos/say when requested or when say is the only local option."""
    preferred = (provider or os.environ.get("HOMUN_TTS_PROVIDER") or "").strip().lower()
    if preferred in ("", "edge", "macos", "say", "macos_say"):
        if macos_say_available() and preferred in ("", "macos", "say", "macos_say"):
            try:
                return macos_say_tts_dispatcher()
            except Exception as exc:
                logger.info("macOS say TTS unavailable: %s", exc)
        if preferred in ("macos", "say", "macos_say"):
            return None
        # Do not silently fall back to inventing Edge success.
        return None
    return None
