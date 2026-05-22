import importlib.util
import json
import pathlib
import unittest


SERVER_PATH = (
    pathlib.Path(__file__).resolve().parents[1]
    / "runtimes"
    / "mlx-gemma4"
    / "server.py"
)


def load_server_module():
    spec = importlib.util.spec_from_file_location("mlx_gemma4_server", SERVER_PATH)
    module = importlib.util.module_from_spec(spec)
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


if __name__ == "__main__":
    unittest.main()
