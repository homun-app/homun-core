#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import re
import signal
import threading
import time
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, ConfigDict, Field


DEFAULT_MODEL = "mlx-community/gemma-4-e4b-it-4bit"
STARTED_AT = time.time()


app = FastAPI(title="Local Gemma 4 MLX Runtime", version="0.1.0")


class GenerateRequest(BaseModel):
    prompt: str
    max_tokens: int = Field(default=512, ge=1, le=4096)
    temperature: float = Field(default=0.0, ge=0.0, le=2.0)


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


class BenchmarkRequest(BaseModel):
    cases: list[BenchmarkCase] | None = None


class GemmaRuntime:
    def __init__(
        self,
        model_name: str = DEFAULT_MODEL,
        loader: Any | None = None,
        generator: Any | None = None,
        template_applier: Any | None = None,
        tool_parser: Any | None = None,
    ):
        self.model_name = model_name
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
    ) -> dict[str, Any]:
        model, processor = self.get_model()
        mx, apply_chat_template, generate = self._mlx_functions()

        with self._generation_lock:
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


runtime = GemmaRuntime(model_name=os.environ.get("GEMMA4_MODEL", DEFAULT_MODEL))


@app.get("/health")
def health() -> dict[str, Any]:
    return {
        "ok": True,
        "model": runtime.model_name,
        "loaded": runtime.loaded,
        "load_seconds": runtime.load_seconds,
        "uptime_seconds": round(time.time() - STARTED_AT, 3),
        "local_first": True,
    }


@app.post("/generate")
def generate(request: GenerateRequest) -> dict[str, Any]:
    return runtime.generate_text(
        request.prompt,
        max_tokens=request.max_tokens,
        temperature=request.temperature,
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
    image_path = Path(request.image_path).expanduser()
    if not image_path.exists():
        raise HTTPException(status_code=400, detail=f"image not found: {image_path}")

    generated = runtime.generate_text(
        request.prompt,
        max_tokens=request.max_tokens,
        temperature=request.temperature,
        image=str(image_path),
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
                valid = True
                errors: list[str] = []
            except Exception as exc:
                output = None
                valid = False
                errors = [f"invalid tool call: {exc}"]
        else:
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
            valid = not errors

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
    }


@app.post("/shutdown")
def shutdown() -> dict[str, Any]:
    threading.Timer(0.2, lambda: os.kill(os.getpid(), signal.SIGTERM)).start()
    return {"ok": True}


def generate_json_response(request: GenerateJsonRequest) -> dict[str, Any]:
    generated = runtime.generate_text(
        request.prompt,
        max_tokens=request.max_tokens,
        temperature=request.temperature,
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
    errors: list[str] = []
    schema_type = schema.get("type")
    if schema_type and not matches_json_type(payload, schema_type):
        errors.append(f"root expected {schema_type}, got {type(payload).__name__}")
        return errors

    properties = schema.get("properties", {})
    if properties and isinstance(payload, dict):
        for key, rule in properties.items():
            if key not in payload:
                continue
            expected_type = rule.get("type") if isinstance(rule, dict) else None
            if expected_type and not matches_json_type(payload[key], expected_type):
                errors.append(
                    f"{key} expected {expected_type}, got {type(payload[key]).__name__}"
                )

            enum = rule.get("enum") if isinstance(rule, dict) else None
            if enum is not None and payload[key] not in enum:
                errors.append(f"{key} must be one of {enum}")

    for key in schema.get("required", []):
        if not isinstance(payload, dict) or key not in payload:
            errors.append(f"missing required key: {key}")

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


def default_benchmark_cases() -> list[BenchmarkCase]:
    return [
        BenchmarkCase(
            id="strict_json",
            prompt=(
                "Rispondi solo con JSON valido, senza markdown. Schema: "
                '{"locale": boolean, "messaggio": string, "rischio": "basso"|"medio"|"alto"}. '
                "Valori: locale true, messaggio ok, rischio basso."
            ),
            max_tokens=80,
            required_keys=["locale", "messaggio", "rischio"],
        ),
        BenchmarkCase(
            id="routine_inference",
            prompt=(
                "Sei il planner di un personal assistant locale. Devi trasformare eventi desktop "
                "in una proposta operativa. Rispondi solo JSON valido, senza markdown.\n"
                "Schema obbligatorio: routine_name, intent, confidence, observed_apps, "
                "required_connectors, missing_connectors, proposed_automation, "
                "requires_user_approval.\n"
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
    ]


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8765)
