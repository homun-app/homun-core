#!/usr/bin/env python3
from __future__ import annotations

import argparse
import importlib.util
import json
import sys
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
SERVER_PATH = ROOT / "runtimes" / "mlx-gemma4" / "server.py"
DEFAULT_OUT = ROOT / "reports" / "gemma4_eval.jsonl"


def main() -> int:
    parser = argparse.ArgumentParser(description="Run the local Gemma 4 benchmark suite.")
    parser.add_argument("--out", default=str(DEFAULT_OUT), help="JSONL report path.")
    args = parser.parse_args()

    server = load_server_module()
    result = server.benchmark(server.BenchmarkRequest())
    out_path = Path(args.out)
    write_jsonl(out_path, report_rows(result))

    print(f"summary: {result['passed']}/{result['total']} passed")
    print(f"report: {out_path.resolve()}")
    return 0 if result["passed"] == result["total"] else 1


def load_server_module():
    spec = importlib.util.spec_from_file_location("mlx_gemma4_server", SERVER_PATH)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def report_rows(result: dict[str, Any]) -> list[dict[str, Any]]:
    rows = []
    for row in result["rows"]:
        metrics = row["metrics"]
        rows.append(
            {
                "id": row["id"],
                "kind": row["kind"],
                "passed": row["valid"],
                "errors": row["errors"],
                "elapsed_seconds": metrics["elapsed_seconds"],
                "prompt_tokens": metrics["prompt_tokens"],
                "generation_tokens": metrics["generation_tokens"],
                "prompt_tps": metrics["prompt_tps"],
                "generation_tps": metrics["generation_tps"],
                "peak_memory_gb": metrics["peak_memory_gb"],
                "output": row["output"],
                "raw_output": row["raw_output"],
            }
        )
    return rows


def write_jsonl(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    raise SystemExit(main())
