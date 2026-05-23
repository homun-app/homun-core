import importlib.util
import json
import os
import pathlib
import sys
import threading
import unittest
from unittest import mock


SERVER_PATH = (
    pathlib.Path(__file__).resolve().parents[1]
    / "runtimes"
    / "mlx-gemma4"
    / "server.py"
)
CONTRACTS_PATH = pathlib.Path(__file__).resolve().parents[1] / "packages" / "shared-contracts"
BENCHMARK_SCRIPT_PATH = pathlib.Path(__file__).resolve().parents[1] / "scripts" / "gemma4_benchmark.py"


def load_server_module():
    spec = importlib.util.spec_from_file_location("mlx_gemma4_server", SERVER_PATH)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class MlxGemma4ServerTests(unittest.TestCase):
    def test_app_exposes_required_local_runtime_endpoints(self):
        server = load_server_module()

        routes = {(route.path, ",".join(sorted(route.methods))) for route in server.app.routes}

        self.assertIn(("/health", "GET"), routes)
        self.assertIn(("/generate_json", "POST"), routes)
        self.assertIn(("/tool_call", "POST"), routes)
        self.assertIn(("/analyze_image", "POST"), routes)
        self.assertIn(("/benchmark", "POST"), routes)

    def test_extract_json_accepts_fenced_model_output(self):
        server = load_server_module()

        payload = server.extract_json('```json\n{"locale": true, "messaggio": "ok"}\n```')

        self.assertEqual(payload, {"locale": True, "messaggio": "ok"})

    def test_validate_json_payload_reports_missing_required_keys(self):
        server = load_server_module()

        errors = server.validate_json_payload({"locale": True}, required_keys=["locale", "rischio"])

        self.assertEqual(errors, ["missing required key: rischio"])

    def test_validate_json_payload_reports_nested_array_item_errors(self):
        server = load_server_module()

        errors = server.validate_json_payload(
            {"findings": ["plain text finding"]},
            schema={
                "type": "object",
                "properties": {
                    "findings": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "required": ["severity", "message"],
                            "properties": {
                                "severity": {"type": "string"},
                                "message": {"type": "string"},
                            },
                        },
                    }
                },
            },
        )

        self.assertEqual(errors, ["findings[0] expected object, got str"])

    def test_runtime_loads_model_only_once(self):
        server = load_server_module()
        calls = []

        def fake_loader(model_name):
            calls.append(model_name)
            return "model", "processor"

        runtime = server.GemmaRuntime(model_name="local-test-model", loader=fake_loader)

        self.assertEqual(runtime.get_model(), ("model", "processor"))
        self.assertEqual(runtime.get_model(), ("model", "processor"))
        self.assertEqual(calls, ["local-test-model"])

    def test_metrics_are_serializable_with_required_fields(self):
        server = load_server_module()

        metrics = server.metrics_from_result(
            result=type(
                "Result",
                (),
                {
                    "prompt_tokens": 10,
                    "generation_tokens": 5,
                    "prompt_tps": 100.1234,
                    "generation_tps": 25.5678,
                    "peak_memory": 5.4321,
                },
            )(),
            elapsed_seconds=1.2345,
        )

        self.assertEqual(
            json.loads(json.dumps(metrics)),
            {
                "prompt_tokens": 10,
                "generation_tokens": 5,
                "prompt_tps": 100.123,
                "generation_tps": 25.568,
                "peak_memory_gb": 5.432,
                "elapsed_seconds": 1.234,
            },
        )

    def test_default_benchmark_preserves_validated_gemma4_eval_coverage(self):
        server = load_server_module()

        cases = server.default_benchmark_cases()

        self.assertEqual(
            [case.id for case in cases],
            [
                "italian_local_assistant",
                "strict_json",
                "routine_inference",
                "memory_extraction",
                "gemma4_tool_call",
                "coding_patch",
                "vision_desktop_summary",
            ],
        )

    def test_runtime_config_reads_local_operational_environment(self):
        with mock.patch.dict(
            os.environ,
            {
                "GEMMA4_MODEL": "local-model",
                "GEMMA4_ALLOWED_IMAGE_ROOTS": "/tmp/images:/tmp/other",
                "GEMMA4_ENABLE_SHUTDOWN": "0",
                "GEMMA4_REJECT_WHEN_BUSY": "1",
                "GEMMA4_REQUEST_TIMEOUT_SECONDS": "7",
            },
            clear=False,
        ):
            server = load_server_module()

            config = server.RuntimeConfig.from_env()

        self.assertEqual(config.model_name, "local-model")
        self.assertEqual([str(path) for path in config.allowed_image_roots], ["/tmp/images", "/tmp/other"])
        self.assertFalse(config.shutdown_enabled)
        self.assertTrue(config.reject_when_busy)
        self.assertEqual(config.default_request_timeout_seconds, 7.0)

    def test_error_payload_has_stable_shape(self):
        server = load_server_module()

        payload = server.error_payload("runtime_busy", "Runtime is busy", retryable=True)

        self.assertEqual(
            payload,
            {
                "error": {
                    "code": "runtime_busy",
                    "message": "Runtime is busy",
                    "retryable": True,
                }
            },
        )

    def test_runtime_rejects_busy_generation_when_wait_is_false(self):
        server = load_server_module()
        runtime = server.GemmaRuntime(
            model_name="local-test-model",
            loader=lambda _: ("model", type("Processor", (), {})()),
            generator=lambda *args, **kwargs: None,
            template_applier=lambda *args, **kwargs: "prompt",
        )
        self.assertTrue(runtime._generation_lock.acquire(blocking=False))
        try:
            with self.assertRaises(server.RuntimeServiceError) as raised:
                runtime.generate_text(
                    "hello",
                    max_tokens=1,
                    wait_if_busy=False,
                    request_timeout_seconds=0.1,
                )
        finally:
            runtime._generation_lock.release()

        self.assertEqual(raised.exception.code, "runtime_busy")
        self.assertEqual(raised.exception.status_code, 429)

    def test_runtime_rejects_expired_deadline_before_generation(self):
        server = load_server_module()
        runtime = server.GemmaRuntime(
            model_name="local-test-model",
            loader=lambda _: ("model", type("Processor", (), {})()),
            generator=lambda *args, **kwargs: None,
            template_applier=lambda *args, **kwargs: "prompt",
        )

        with self.assertRaises(server.RuntimeServiceError) as raised:
            runtime.generate_text("hello", max_tokens=1, request_timeout_seconds=0)

        self.assertEqual(raised.exception.code, "request_timeout")
        self.assertEqual(raised.exception.status_code, 408)

    def test_image_paths_must_stay_inside_configured_roots(self):
        server = load_server_module()
        root = pathlib.Path("/tmp/local-first-images").resolve()
        config = server.RuntimeConfig(
            model_name="local-test-model",
            allowed_image_roots=[root],
        )

        valid = server.validate_local_image_path(root / "screen.png", config)

        self.assertEqual(valid, root / "screen.png")
        with self.assertRaises(server.RuntimeServiceError) as raised:
            server.validate_local_image_path("/etc/passwd", config)
        self.assertEqual(raised.exception.code, "image_path_not_allowed")

    def test_benchmark_summary_aggregates_runtime_metrics(self):
        server = load_server_module()
        rows = [
            {
                "valid": True,
                "metrics": {
                    "prompt_tokens": 10,
                    "generation_tokens": 5,
                    "prompt_tps": 100.0,
                    "generation_tps": 20.0,
                    "peak_memory_gb": 3.5,
                    "elapsed_seconds": 1.2,
                },
            },
            {
                "valid": False,
                "metrics": {
                    "prompt_tokens": 2,
                    "generation_tokens": 1,
                    "prompt_tps": 50.0,
                    "generation_tps": 10.0,
                    "peak_memory_gb": 4.0,
                    "elapsed_seconds": 0.8,
                },
            },
        ]

        summary = server.benchmark_summary(rows)

        self.assertEqual(summary["prompt_tokens"], 12)
        self.assertEqual(summary["generation_tokens"], 6)
        self.assertEqual(summary["peak_memory_gb"], 4.0)
        self.assertEqual(summary["elapsed_seconds"], 2.0)

    def test_shutdown_can_be_disabled(self):
        server = load_server_module()
        original_config = server.runtime.config
        server.runtime.config = server.RuntimeConfig(shutdown_enabled=False)
        try:
            with self.assertRaises(server.HTTPException) as raised:
                server.shutdown()
        finally:
            server.runtime.config = original_config

        self.assertEqual(raised.exception.status_code, 403)
        self.assertEqual(raised.exception.detail["error"]["code"], "shutdown_disabled")


class SharedContractTests(unittest.TestCase):
    def test_subagent_contract_schemas_are_present_and_parseable(self):
        expected = [
            "subagents/subagent_task.schema.json",
            "subagents/subagent_result.schema.json",
            "subagents/subagent_review.schema.json",
        ]

        for relative_path in expected:
            path = CONTRACTS_PATH / relative_path
            with self.subTest(path=relative_path):
                data = json.loads(path.read_text(encoding="utf-8"))
                self.assertEqual(data["$schema"], "https://json-schema.org/draft/2020-12/schema")
                self.assertEqual(data["type"], "object")
                self.assertIn("required", data)


class BenchmarkScriptTests(unittest.TestCase):
    def test_report_rows_flatten_benchmark_result_for_jsonl(self):
        spec = importlib.util.spec_from_file_location("gemma4_benchmark", BENCHMARK_SCRIPT_PATH)
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module
        spec.loader.exec_module(module)

        rows = module.report_rows(
            {
                "rows": [
                    {
                        "id": "strict_json",
                        "kind": "json",
                        "valid": True,
                        "errors": [],
                        "output": {"ok": True},
                        "raw_output": "{\"ok\": true}",
                        "metrics": {
                            "prompt_tokens": 1,
                            "generation_tokens": 2,
                            "prompt_tps": 3.0,
                            "generation_tps": 4.0,
                            "peak_memory_gb": 5.0,
                            "elapsed_seconds": 6.0,
                        },
                    }
                ]
            }
        )

        self.assertEqual(rows[0]["id"], "strict_json")
        self.assertTrue(rows[0]["passed"])
        self.assertEqual(rows[0]["prompt_tokens"], 1)
        self.assertEqual(rows[0]["output"], {"ok": True})


if __name__ == "__main__":
    unittest.main()
