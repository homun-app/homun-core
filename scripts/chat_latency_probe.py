#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Iterable


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUT = ROOT / "reports" / "chat_latency_probe.jsonl"
DEFAULT_BASE_URL = "http://127.0.0.1:8765"


@dataclass(frozen=True)
class ProbeCase:
    id: str
    prompt: str
    max_tokens: int = 180


DEFAULT_CASES = [
    ProbeCase(
        id="short_time_like_answer",
        prompt="Rispondi in italiano con una frase breve: che cosa puoi fare?",
        max_tokens=80,
    ),
    ProbeCase(
        id="simple_math",
        prompt="Quanto fa 6 * 3? Rispondi solo con il risultato e una frase breve.",
        max_tokens=40,
    ),
    ProbeCase(
        id="small_code",
        prompt='Fammi un esempio minimo di codice Rust che stampa "Hello, world!".',
        max_tokens=160,
    ),
]


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Measure local Gemma chat streaming latency with realistic prompts."
    )
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL)
    parser.add_argument("--out", default=str(DEFAULT_OUT), help="JSONL report path.")
    parser.add_argument("--no-warmup", action="store_true", help="Skip /warmup before probing.")
    parser.add_argument(
        "--timeout",
        type=float,
        default=180.0,
        help="HTTP timeout per request in seconds.",
    )
    parser.add_argument(
        "--repeat",
        type=int,
        default=1,
        help="Run each probe case this many times.",
    )
    args = parser.parse_args()

    result = run_probe(
        base_url=args.base_url.rstrip("/"),
        cases=DEFAULT_CASES,
        warmup=not args.no_warmup,
        timeout=args.timeout,
        repeat=max(1, args.repeat),
    )
    out_path = Path(args.out)
    write_jsonl(out_path, result["rows"])

    summary = result["summary"]
    print(
        "summary: "
        f"{summary['total']} cases, "
        f"avg first token {summary['avg_time_to_first_token_seconds']}s, "
        f"avg total {summary['avg_total_elapsed_seconds']}s"
    )
    print(f"runtime before: {result['runtime_status_before']}")
    print(f"report: {out_path.resolve()}")
    return 0


def run_probe(
    *,
    base_url: str,
    cases: Iterable[ProbeCase],
    warmup: bool,
    timeout: float,
    repeat: int = 1,
) -> dict[str, Any]:
    health_before = get_json(f"{base_url}/health", timeout=timeout)
    runtime_status_before = runtime_status_from_health(health_before)
    warmup_payload = None
    if warmup:
        warmup_payload = post_json(f"{base_url}/warmup", {}, timeout=timeout)

    rows = []
    for run_index, case in iter_probe_cases(cases, repeat=repeat):
        row = run_stream_case(
            base_url=base_url,
            case=case,
            timeout=timeout,
            runtime_status_before=runtime_status_before,
        )
        row["run_index"] = run_index
        rows.append(row)
    return {
        "runtime_status_before": runtime_status_before,
        "health_before": health_before,
        "warmup": warmup_payload,
        "rows": rows,
        "summary": summarize_rows(rows),
    }


def iter_probe_cases(
    cases: Iterable[ProbeCase],
    *,
    repeat: int,
) -> Iterable[tuple[int, ProbeCase]]:
    materialized = list(cases)
    for run_index in range(1, max(1, repeat) + 1):
        for case in materialized:
            yield run_index, case


def run_stream_case(
    *,
    base_url: str,
    case: ProbeCase,
    timeout: float,
    runtime_status_before: str,
) -> dict[str, Any]:
    payload = {
        "prompt": case.prompt,
        "max_tokens": case.max_tokens,
        "temperature": 0.0,
        "wait_if_busy": True,
        "request_timeout_seconds": timeout,
        "request_id": f"probe_{case.id}_{int(time.time() * 1000)}",
    }
    started = time.perf_counter()
    lines = post_stream_lines(f"{base_url}/generate_stream", payload, timeout=timeout)
    parsed = consume_stream_events(lines, now=time.perf_counter, started=started)
    return {
        "id": case.id,
        "prompt_chars": len(case.prompt),
        "max_tokens": case.max_tokens,
        "runtime_status_before": runtime_status_before,
        **parsed,
    }


def consume_stream_events(
    lines: Iterable[bytes | str],
    *,
    now: Callable[[], float],
    started: float,
) -> dict[str, Any]:
    text_parts: list[str] = []
    metrics: dict[str, Any] | None = None
    first_delta_at: float | None = None

    for line in lines:
        decoded = line.decode("utf-8") if isinstance(line, bytes) else line
        decoded = decoded.strip()
        if not decoded:
            continue
        event = json.loads(decoded)
        if event.get("type") == "delta":
            if first_delta_at is None:
                first_delta_at = now()
            text_parts.append(str(event.get("text", "")))
        elif event.get("type") == "done":
            metrics = dict(event.get("metrics") or {})
            if event.get("text") and not text_parts:
                text_parts.append(str(event["text"]))
        elif event.get("type") == "error":
            raise RuntimeError(f"{event.get('code', 'runtime_error')}: {event.get('message', '')}")

    finished = now()
    output = "".join(text_parts).strip()
    return {
        "ok": bool(output),
        "time_to_first_token_seconds": rounded_seconds(first_delta_at - started)
        if first_delta_at is not None
        else None,
        "total_elapsed_seconds": rounded_seconds(finished - started),
        "output_chars": len(output),
        "output_preview": output[:240],
        "metrics": metrics or {},
    }


def summarize_rows(rows: list[dict[str, Any]]) -> dict[str, Any]:
    first_token_values = [
        row["time_to_first_token_seconds"]
        for row in rows
        if row["time_to_first_token_seconds"] is not None
    ]
    total_values = [row["total_elapsed_seconds"] for row in rows]
    return {
        "total": len(rows),
        "ok": sum(1 for row in rows if row["ok"]),
        "avg_time_to_first_token_seconds": rounded_seconds(mean(first_token_values)),
        "avg_total_elapsed_seconds": rounded_seconds(mean(total_values)),
        "max_total_elapsed_seconds": rounded_seconds(max(total_values) if total_values else 0),
    }


def get_json(url: str, *, timeout: float) -> dict[str, Any]:
    with urllib.request.urlopen(url, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def post_json(url: str, payload: dict[str, Any], *, timeout: float) -> dict[str, Any]:
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def post_stream_lines(
    url: str,
    payload: dict[str, Any],
    *,
    timeout: float,
) -> Iterable[bytes]:
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        response = urllib.request.urlopen(request, timeout=timeout)
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {error.code}: {detail}") from error
    return response


def runtime_status_from_health(payload: dict[str, Any]) -> str:
    if not payload.get("ok"):
        return "unhealthy"
    return "loaded" if payload.get("loaded") else "not_loaded"


def write_jsonl(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")


def mean(values: list[float]) -> float:
    if not values:
        return 0.0
    return sum(values) / len(values)


def rounded_seconds(value: float) -> float:
    return round(value, 3)


if __name__ == "__main__":
    raise SystemExit(main())
