#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import re
import signal
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field


DEFAULT_MODEL = "mlx-community/gemma-4-e4b-it-4bit"
STARTED_AT = time.time()


app = FastAPI(title="Local Gemma 4 MLX Runtime", version="0.2.0")


@dataclass
class RuntimeConfig:
    model_name: str = DEFAULT_MODEL
    allowed_image_roots: list[Path] = field(default_factory=list)
    shutdown_enabled: bool = False
    reject_when_busy: bool = False
    default_request_timeout_seconds: float = 120.0

    @classmethod
    def from_env(cls) -> "RuntimeConfig":
        roots = [
            Path(value).expanduser()
            for value in os.environ.get("GEMMA4_ALLOWED_IMAGE_ROOTS", "").split(":")
            if value
        ]
        return cls(
            model_name=os.environ.get("GEMMA4_MODEL", DEFAULT_MODEL),
            allowed_image_roots=roots,
            shutdown_enabled=env_bool("GEMMA4_ENABLE_SHUTDOWN", default=False),
            reject_when_busy=env_bool("GEMMA4_REJECT_WHEN_BUSY", default=False),
            default_request_timeout_seconds=float(
                os.environ.get("GEMMA4_REQUEST_TIMEOUT_SECONDS", "120")
            ),
        )


class RuntimeServiceError(Exception):
    def __init__(
        self,
        code: str,
        message: str,
        *,
        status_code: int = 500,
        retryable: bool = False,
    ):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code
        self.retryable = retryable


def env_bool(name: str, *, default: bool) -> bool:
    value = os.environ.get(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def error_payload(code: str, message: str, *, retryable: bool = False) -> dict[str, Any]:
    return {
        "error": {
            "code": code,
            "message": message,
            "retryable": retryable,
        }
    }


def validate_local_image_path(path: str | Path, config: RuntimeConfig) -> Path:
    image_path = Path(path).expanduser()
    if not config.allowed_image_roots:
        return image_path

    resolved = image_path.resolve(strict=False)
    for root in config.allowed_image_roots:
        resolved_root = root.expanduser().resolve(strict=False)
        if resolved == resolved_root or resolved_root in resolved.parents:
            return resolved

    raise RuntimeServiceError(
        "image_path_not_allowed",
        "Image path is outside configured local roots",
        status_code=400,
    )


class GenerateRequest(BaseModel):
    prompt: str
    max_tokens: int = Field(default=512, ge=1, le=4096)
    temperature: float = Field(default=0.0, ge=0.0, le=2.0)
    wait_if_busy: bool = True
    request_timeout_seconds: float | None = Field(default=None, ge=0.0, le=3600.0)


class GenerateJsonRequest(GenerateRequest):
    model_config = ConfigDict(populate_by_name=True)

    json_schema: dict[str, Any] | None = Field(default=None, alias="schema")
    required_keys: list[str] = Field(default_factory=list)
    repair: bool = True


class ToolCallRequest(GenerateRequest):
    tools: list[dict[str, Any]]


class AnalyzeImageRequest(GenerateJsonRequest):
    image_path: str


class BenchmarkCase(BaseModel):
    id: str
    kind: str = "json"
    prompt: str
    max_tokens: int = Field(default=220, ge=1, le=4096)
    required_keys: list[str] = Field(default_factory=list)
    image_path: str | None = None
    tools: list[dict[str, Any]] | None = None
    expected_json: dict[str, Any] | None = None
    contains: list[str] = Field(default_factory=list)
    required_tool_name: str | None = None


class BenchmarkRequest(BaseModel):
    cases: list[BenchmarkCase] | None = None


class GemmaRuntime:
    def __init__(
        self,
        model_name: str = DEFAULT_MODEL,
        config: RuntimeConfig | None = None,
        loader: Any | None = None,
        generator: Any | None = None,
        template_applier: Any | None = None,
        tool_parser: Any | None = None,
    ):
        self.config = config or RuntimeConfig(model_name=model_name)
        self.model_name = self.config.model_name
        self.loader = loader
        self.generator = generator
        self.template_applier = template_applier
        self.tool_parser = tool_parser
        self.model = None
        self.processor = None
        self.loaded_at = None
        self.load_seconds = None
        self._lock = threading.Lock()
        self._generation_lock = threading.Lock()

    @property
    def loaded(self) -> bool:
        return self.model is not None and self.processor is not None

    def get_model(self):
        if self.loaded:
            return self.model, self.processor

        with self._lock:
            if self.loaded:
                return self.model, self.processor

            if self.loader is None:
                from mlx_vlm import load

                self.loader = load

            started = time.perf_counter()
            self.model, self.processor = self.loader(self.model_name)
            self.load_seconds = round(time.perf_counter() - started, 3)
            self.loaded_at = time.time()
            return self.model, self.processor

    def generate_text(
        self,
        prompt: str,
        *,
        max_tokens: int,
        temperature: float = 0.0,
        image: str | None = None,
        tools: list[dict[str, Any]] | None = None,
        wait_if_busy: bool | None = None,
        request_timeout_seconds: float | None = None,
    ) -> dict[str, Any]:
        timeout = self.config.default_request_timeout_seconds
        if request_timeout_seconds is not None:
            timeout = request_timeout_seconds
        if timeout <= 0:
            raise RuntimeServiceError(
                "request_timeout",
                "Request deadline expired before generation started",
                status_code=408,
                retryable=True,
            )

        wait = wait_if_busy
        if wait is None:
            wait = not self.config.reject_when_busy
        if wait:
            acquired = self._generation_lock.acquire(timeout=timeout)
        else:
            acquired = self._generation_lock.acquire(blocking=False)
        if not acquired:
            raise RuntimeServiceError(
                "runtime_busy",
                "Runtime is busy",
                status_code=429,
                retryable=True,
            )

        try:
            model, processor = self.get_model()
            mx, apply_chat_template, generate = self._mlx_functions()
            mx.reset_peak_memory()
            prompt_kwargs: dict[str, Any] = {}
            if tools is not None:
                prompt_kwargs["tools"] = tools

            formatted_prompt = apply_chat_template(
                processor,
                model.config,
                prompt,
                num_images=1 if image else 0,
                **prompt_kwargs,
            )

            started = time.perf_counter()
            result = generate(
                model,
                processor,
                formatted_prompt,
                image=image,
                max_tokens=max_tokens,
                temperature=temperature,
                verbose=False,
            )
            elapsed = time.perf_counter() - started
        finally:
            self._generation_lock.release()

        return {
            "text": result.text.strip(),
            "metrics": metrics_from_result(result, elapsed),
        }

    def parse_tool_call(self, text: str) -> dict[str, Any]:
        if self.tool_parser is None:
            from mlx_vlm.tool_parsers.gemma4 import parse_tool_call

            self.tool_parser = parse_tool_call
        return self.tool_parser(text)

    def _mlx_functions(self):
        if self.generator is None:
            from mlx_vlm import generate

            self.generator = generate
        if self.template_applier is None:
            from mlx_vlm import apply_chat_template

            self.template_applier = apply_chat_template

        import mlx.core as mx

        return mx, self.template_applier, self.generator


runtime = GemmaRuntime(config=RuntimeConfig.from_env())


@app.exception_handler(RuntimeServiceError)
def runtime_service_error_handler(
    _request: Request, exc: RuntimeServiceError
) -> JSONResponse:
    return JSONResponse(
        status_code=exc.status_code,
        content=error_payload(exc.code, exc.message, retryable=exc.retryable),
    )


@app.get("/health")
def health() -> dict[str, Any]:
    return {
        "ok": True,
        "model": runtime.model_name,
        "loaded": runtime.loaded,
        "load_seconds": runtime.load_seconds,
        "uptime_seconds": round(time.time() - STARTED_AT, 3),
        "local_first": True,
        "shutdown_enabled": runtime.config.shutdown_enabled,
        "reject_when_busy": runtime.config.reject_when_busy,
        "allowed_image_roots": [str(path) for path in runtime.config.allowed_image_roots],
    }


@app.post("/generate")
def generate(request: GenerateRequest) -> dict[str, Any]:
    return runtime.generate_text(
        request.prompt,
        max_tokens=request.max_tokens,
        temperature=request.temperature,
        wait_if_busy=request.wait_if_busy,
        request_timeout_seconds=request.request_timeout_seconds,
    )


@app.post("/generate_json")
def generate_json(request: GenerateJsonRequest) -> dict[str, Any]:
    return generate_json_response(request)


@app.post("/tool_call")
def tool_call(request: ToolCallRequest) -> dict[str, Any]:
    generated = runtime.generate_text(
        request.prompt,
        max_tokens=request.max_tokens,
        temperature=request.temperature,
        tools=request.tools,
        wait_if_busy=request.wait_if_busy,
        request_timeout_seconds=request.request_timeout_seconds,
    )
    try:
        call = runtime.parse_tool_call(generated["text"])
    except Exception as exc:
        raise HTTPException(status_code=422, detail=f"invalid tool call: {exc}") from exc

    return {
        "valid": True,
        "tool_call": call,
        "raw_output": generated["text"],
        "metrics": generated["metrics"],
    }


@app.post("/analyze_image")
def analyze_image(request: AnalyzeImageRequest) -> dict[str, Any]:
    image_path = validate_local_image_path(request.image_path, runtime.config)
    if not image_path.exists():
        raise HTTPException(
            status_code=400,
            detail=error_payload("image_not_found", f"image not found: {image_path}")["error"],
        )

    generated = runtime.generate_text(
        request.prompt,
        max_tokens=request.max_tokens,
        temperature=request.temperature,
        image=str(image_path),
        wait_if_busy=request.wait_if_busy,
        request_timeout_seconds=request.request_timeout_seconds,
    )
    return validated_json_response(
        generated,
        schema=request.json_schema,
        required_keys=request.required_keys,
        repair_source=request if request.repair else None,
    )


@app.post("/benchmark")
def benchmark(request: BenchmarkRequest) -> dict[str, Any]:
    rows = []
    for case in request.cases or default_benchmark_cases():
        if case.kind == "tool":
            generated = runtime.generate_text(
                case.prompt,
                max_tokens=case.max_tokens,
                temperature=0.0,
                tools=case.tools,
            )
            try:
                output: Any = runtime.parse_tool_call(generated["text"])
                errors = validate_tool_output(output, case)
                valid = not errors
            except Exception as exc:
                output = None
                valid = False
                errors = [f"invalid tool call: {exc}"]
        elif case.kind in {"json", "vision"}:
            image = case.image_path if case.kind == "vision" else None
            generated = runtime.generate_text(
                case.prompt,
                max_tokens=case.max_tokens,
                temperature=0.0,
                image=image,
                tools=case.tools,
            )
            output, errors = parse_and_validate_json(
                generated["text"], required_keys=case.required_keys
            )
            if output is not None:
                errors.extend(validate_expected_json(output, case))
            valid = not errors
        elif case.kind == "text":
            generated = runtime.generate_text(
                case.prompt,
                max_tokens=case.max_tokens,
                temperature=0.0,
                tools=case.tools,
            )
            output = generated["text"]
            errors = validate_text_output(output, case)
            valid = not errors
        else:
            raise HTTPException(status_code=400, detail=f"unknown benchmark kind: {case.kind}")

        rows.append(
            {
                "id": case.id,
                "kind": case.kind,
                "valid": valid,
                "errors": errors,
                "output": output,
                "raw_output": generated["text"],
                "metrics": generated["metrics"],
            }
        )

    return {
        "passed": sum(1 for row in rows if row["valid"]),
        "total": len(rows),
        "rows": rows,
        "summary": benchmark_summary(rows),
    }


@app.post("/shutdown")
def shutdown() -> dict[str, Any]:
    if not runtime.config.shutdown_enabled:
        raise HTTPException(
            status_code=403,
            detail=error_payload(
                "shutdown_disabled",
                "Shutdown endpoint is disabled",
                retryable=False,
            ),
        )
    threading.Timer(0.2, lambda: os.kill(os.getpid(), signal.SIGTERM)).start()
    return {"ok": True}


def generate_json_response(request: GenerateJsonRequest) -> dict[str, Any]:
    generated = runtime.generate_text(
        request.prompt,
        max_tokens=request.max_tokens,
        temperature=request.temperature,
        wait_if_busy=request.wait_if_busy,
        request_timeout_seconds=request.request_timeout_seconds,
    )
    return validated_json_response(
        generated,
        schema=request.json_schema,
        required_keys=request.required_keys,
        repair_source=request if request.repair else None,
    )


def validated_json_response(
    generated: dict[str, Any],
    *,
    schema: dict[str, Any] | None,
    required_keys: list[str],
    repair_source: GenerateJsonRequest | None,
) -> dict[str, Any]:
    output, errors = parse_and_validate_json(
        generated["text"], schema=schema, required_keys=required_keys
    )
    repaired = False

    if errors and repair_source is not None:
        repair_prompt = build_json_repair_prompt(
            generated["text"],
            schema=schema,
            required_keys=required_keys,
        )
        repaired_generation = runtime.generate_text(
            repair_prompt,
            max_tokens=repair_source.max_tokens,
            temperature=0.0,
            wait_if_busy=repair_source.wait_if_busy,
            request_timeout_seconds=repair_source.request_timeout_seconds,
        )
        output, errors = parse_and_validate_json(
            repaired_generation["text"], schema=schema, required_keys=required_keys
        )
        if not errors:
            generated = repaired_generation
            repaired = True

    return {
        "valid": not errors,
        "errors": errors,
        "json": output,
        "raw_output": generated["text"],
        "repaired": repaired,
        "metrics": generated["metrics"],
    }


def extract_json(text: str) -> Any:
    cleaned = text.strip()
    fenced = re.search(r"```(?:json)?\s*(.*?)```", cleaned, flags=re.S)
    if fenced:
        cleaned = fenced.group(1).strip()

    start_candidates = [index for index in (cleaned.find("{"), cleaned.find("[")) if index >= 0]
    if start_candidates:
        cleaned = cleaned[min(start_candidates) :]

    return json.loads(cleaned)


def parse_and_validate_json(
    text: str,
    *,
    schema: dict[str, Any] | None = None,
    required_keys: list[str] | None = None,
) -> tuple[Any | None, list[str]]:
    try:
        payload = extract_json(text)
    except Exception as exc:
        return None, [f"invalid json: {exc}"]

    return payload, validate_json_payload(payload, schema=schema, required_keys=required_keys or [])


def validate_json_payload(
    payload: Any,
    *,
    schema: dict[str, Any] | None = None,
    required_keys: list[str] | None = None,
) -> list[str]:
    errors: list[str] = []
    required_keys = required_keys or []

    if required_keys and not isinstance(payload, dict):
        return ["json payload must be an object when required_keys is set"]

    for key in required_keys:
        if key not in payload:
            errors.append(f"missing required key: {key}")

    if schema:
        errors.extend(validate_simple_schema(payload, schema))

    return errors


def validate_simple_schema(payload: Any, schema: dict[str, Any]) -> list[str]:
    return validate_schema_node(payload, schema, path="")


def validate_schema_node(payload: Any, schema: dict[str, Any], *, path: str) -> list[str]:
    errors: list[str] = []
    schema_type = schema.get("type")
    if schema_type and not matches_json_type(payload, schema_type):
        label = path or "root"
        errors.append(f"{label} expected {schema_type}, got {type(payload).__name__}")
        return errors

    enum = schema.get("enum")
    if enum is not None and payload not in enum:
        label = path or "root"
        errors.append(f"{label} must be one of {enum}")

    properties = schema.get("properties", {})
    if properties and isinstance(payload, dict):
        for key, rule in properties.items():
            if key not in payload:
                continue
            if isinstance(rule, dict):
                child_path = f"{path}.{key}" if path else key
                errors.extend(validate_schema_node(payload[key], rule, path=child_path))

    item_schema = schema.get("items")
    if item_schema and isinstance(item_schema, dict) and isinstance(payload, list):
        for index, item in enumerate(payload):
            item_path = f"{path}[{index}]" if path else f"[{index}]"
            errors.extend(validate_schema_node(item, item_schema, path=item_path))

    for key in schema.get("required", []):
        if not isinstance(payload, dict) or key not in payload:
            label = f"{path}.{key}" if path else key
            errors.append(f"missing required key: {label}")

    return errors


def matches_json_type(value: Any, expected_type: str | list[str]) -> bool:
    if isinstance(expected_type, list):
        return any(matches_json_type(value, item) for item in expected_type)

    type_map = {
        "object": dict,
        "array": list,
        "string": str,
        "number": (int, float),
        "integer": int,
        "boolean": bool,
        "null": type(None),
    }
    python_type = type_map.get(expected_type)
    if python_type is None:
        return True
    if expected_type == "number" and isinstance(value, bool):
        return False
    if expected_type == "integer" and isinstance(value, bool):
        return False
    return isinstance(value, python_type)


def build_json_repair_prompt(
    raw_output: str,
    *,
    schema: dict[str, Any] | None,
    required_keys: list[str],
) -> str:
    return (
        "Converti il testo seguente in JSON valido. Rispondi solo con JSON, senza markdown.\n"
        f"Chiavi obbligatorie: {json.dumps(required_keys, ensure_ascii=False)}\n"
        f"Schema: {json.dumps(schema or {}, ensure_ascii=False)}\n"
        f"Testo:\n{raw_output}"
    )


def metrics_from_result(result: Any, elapsed_seconds: float) -> dict[str, Any]:
    return {
        "prompt_tokens": result.prompt_tokens,
        "generation_tokens": result.generation_tokens,
        "prompt_tps": round(result.prompt_tps, 3),
        "generation_tps": round(result.generation_tps, 3),
        "peak_memory_gb": round(result.peak_memory, 3),
        "elapsed_seconds": round(elapsed_seconds, 3),
    }


def benchmark_summary(rows: list[dict[str, Any]]) -> dict[str, Any]:
    metrics = [row.get("metrics", {}) for row in rows]
    return {
        "prompt_tokens": sum(int(row.get("prompt_tokens", 0)) for row in metrics),
        "generation_tokens": sum(int(row.get("generation_tokens", 0)) for row in metrics),
        "peak_memory_gb": round(
            max((float(row.get("peak_memory_gb", 0.0)) for row in metrics), default=0.0),
            3,
        ),
        "elapsed_seconds": round(
            sum(float(row.get("elapsed_seconds", 0.0)) for row in metrics),
            3,
        ),
    }


def validate_expected_json(payload: Any, case: BenchmarkCase) -> list[str]:
    errors: list[str] = []
    if not case.expected_json:
        return errors
    if not isinstance(payload, dict):
        return ["json payload must be an object when expected_json is set"]
    for key, value in case.expected_json.items():
        if payload.get(key) != value:
            errors.append(f"{key} expected {value!r}, got {payload.get(key)!r}")
    return errors


def validate_text_output(text: str, case: BenchmarkCase) -> list[str]:
    if not text.strip():
        return ["empty output"]
    missing = [fragment for fragment in case.contains if fragment not in text]
    return [f"missing text fragment: {fragment}" for fragment in missing]


def validate_tool_output(output: dict[str, Any], case: BenchmarkCase) -> list[str]:
    if case.required_tool_name and output.get("name") != case.required_tool_name:
        return [f"wrong tool: {output.get('name')}"]
    return []


def make_vision_fixture(path: Path) -> Path:
    if path.exists():
        return path

    from PIL import Image, ImageDraw, ImageFont

    path.parent.mkdir(parents=True, exist_ok=True)
    image = Image.new("RGB", (1200, 720), color=(246, 247, 249))
    draw = ImageDraw.Draw(image)
    font_title = ImageFont.load_default(size=42)
    font = ImageFont.load_default(size=32)

    draw.rectangle((40, 40, 1160, 680), outline=(40, 52, 68), width=4)
    draw.text((80, 90), "PROJECT: Acme App", fill=(15, 23, 42), font=font_title)
    draw.text((80, 180), "TRELLO: 3 assigned tasks", fill=(20, 83, 45), font=font)
    draw.text((80, 250), "MATTERMOST: 2 unread messages", fill=(127, 29, 29), font=font)
    draw.text((80, 320), "GIT: main branch clean", fill=(30, 64, 175), font=font)
    draw.text((80, 430), "NEXT ACTION: review tasks before coding", fill=(15, 23, 42), font=font)
    image.save(path)
    return path


def default_benchmark_cases() -> list[BenchmarkCase]:
    tools = [
        {
            "type": "function",
            "function": {
                "name": "trello_get_assigned_cards",
                "description": "Legge le card Trello assegnate all'utente.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "board": {"type": "string"},
                        "assignee": {"type": "string"},
                    },
                    "required": ["board", "assignee"],
                },
            },
        }
    ]
    vision_fixture = make_vision_fixture(Path("reports/gemma4_vision_fixture.png"))

    return [
        BenchmarkCase(
            id="italian_local_assistant",
            kind="text",
            prompt="Rispondi in italiano, massimo 12 parole: sei un assistente locale?",
            max_tokens=40,
        ),
        BenchmarkCase(
            id="strict_json",
            kind="json",
            prompt=(
                "Rispondi solo con JSON valido, senza markdown. Schema: "
                '{"locale": boolean, "messaggio": string, "rischio": "basso"|"medio"|"alto"}. '
                "Valori: locale true, messaggio ok, rischio basso."
            ),
            max_tokens=80,
            required_keys=["locale", "messaggio", "rischio"],
            expected_json={"locale": True, "messaggio": "ok", "rischio": "basso"},
        ),
        BenchmarkCase(
            id="routine_inference",
            kind="json",
            prompt=(
                "Sei il planner di un personal assistant locale. Devi trasformare eventi desktop "
                "in una proposta operativa. Rispondi solo JSON valido, senza markdown.\n"
                "Schema obbligatorio:\n"
                "{"
                '"routine_name": string, '
                '"intent": string, '
                '"confidence": number, '
                '"observed_apps": string[], '
                '"required_connectors": string[], '
                '"missing_connectors": string[], '
                '"proposed_automation": string, '
                '"requires_user_approval": boolean'
                "}\n"
                "Regole:\n"
                '- Se vedi trello.com, required_connectors deve includere "trello".\n'
                '- Se vedi mattermost, required_connectors deve includere "mattermost".\n'
                '- Se vedi git pull, required_connectors deve includere "git".\n'
                "- missing_connectors deve contenere i connettori richiesti che non risultano già configurati.\n"
                "- In questo scenario non ci sono connettori configurati.\n"
                "- Non inventare 'none' o spiegazioni testuali dentro missing_connectors.\n\n"
                "Eventi:\n"
                "08:58 open_app Zed\n"
                "08:59 open_folder /Clients/Acme/app\n"
                "09:01 terminal git pull\n"
                "09:03 browser trello.com board Acme\n"
                "09:06 browser mattermost.acme.local unread messages\n"
            ),
            max_tokens=240,
            required_keys=[
                "routine_name",
                "intent",
                "confidence",
                "observed_apps",
                "required_connectors",
                "missing_connectors",
                "proposed_automation",
                "requires_user_approval",
            ],
        ),
        BenchmarkCase(
            id="memory_extraction",
            kind="json",
            prompt=(
                "Estrai solo memorie durevoli dal testo. Rispondi JSON valido: "
                '{"memories":[{"fact":string,"category":string,"confidence":number}]}.\n'
                "Testo: Fabio lavora spesso sul progetto Acme la mattina. "
                "Preferisce Zed come editor. Oggi è irritato perché il download è lento. "
                "Il repository principale è /Clients/Acme/app."
            ),
            max_tokens=180,
            required_keys=["memories"],
        ),
        BenchmarkCase(
            id="gemma4_tool_call",
            kind="tool",
            tools=tools,
            prompt=(
                "Usa lo strumento disponibile per leggere le card Trello assegnate a Fabio "
                "sul board Acme. Non spiegare, chiama lo strumento."
            ),
            max_tokens=120,
            required_tool_name="trello_get_assigned_cards",
        ),
        BenchmarkCase(
            id="coding_patch",
            kind="text",
            prompt=(
                "Correggi questa funzione Python e restituisci solo il codice finale:\n"
                "def average(xs):\n"
                "    return sum(xs) / len(xs)\n\n"
                "Requisiti: se xs è vuota restituisci None; non lanciare eccezioni."
            ),
            max_tokens=140,
            contains=["def average", "None"],
        ),
        BenchmarkCase(
            id="vision_desktop_summary",
            kind="vision",
            image_path=str(vision_fixture),
            prompt=(
                "Leggi l'immagine. Rispondi solo JSON valido con chiavi "
                "project, trello_tasks, mattermost_unread, git_status."
            ),
            max_tokens=160,
            required_keys=["project", "trello_tasks", "mattermost_unread", "git_status"],
        ),
    ]


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8765)
