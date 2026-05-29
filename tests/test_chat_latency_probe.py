import importlib.util
import json
import pathlib
import sys
import unittest


SCRIPT_PATH = pathlib.Path(__file__).resolve().parents[1] / "scripts" / "chat_latency_probe.py"


def load_probe_module():
    spec = importlib.util.spec_from_file_location("chat_latency_probe", SCRIPT_PATH)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class ChatLatencyProbeTests(unittest.TestCase):
    def test_consume_stream_events_records_first_token_total_and_metrics(self):
        probe = load_probe_module()
        ticks = iter([10.25, 11.5])

        row = probe.consume_stream_events(
            [
                json.dumps({"type": "delta", "text": "Ciao"}),
                json.dumps({"type": "delta", "text": " Fabio"}),
                json.dumps(
                    {
                        "type": "done",
                        "text": "Ciao Fabio",
                        "metrics": {
                            "prompt_tokens": 12,
                            "generation_tokens": 2,
                            "elapsed_seconds": 1.2,
                        },
                    }
                ),
            ],
            now=lambda: next(ticks),
            started=10.0,
        )

        self.assertTrue(row["ok"])
        self.assertEqual(row["time_to_first_token_seconds"], 0.25)
        self.assertEqual(row["total_elapsed_seconds"], 1.5)
        self.assertEqual(row["output_chars"], len("Ciao Fabio"))
        self.assertEqual(row["metrics"]["generation_tokens"], 2)

    def test_summarize_rows_aggregates_success_and_latency(self):
        probe = load_probe_module()

        summary = probe.summarize_rows(
            [
                {
                    "ok": True,
                    "time_to_first_token_seconds": 0.2,
                    "total_elapsed_seconds": 1.0,
                },
                {
                    "ok": True,
                    "time_to_first_token_seconds": 0.4,
                    "total_elapsed_seconds": 2.0,
                },
            ]
        )

        self.assertEqual(summary["total"], 2)
        self.assertEqual(summary["ok"], 2)
        self.assertEqual(summary["avg_time_to_first_token_seconds"], 0.3)
        self.assertEqual(summary["avg_total_elapsed_seconds"], 1.5)
        self.assertEqual(summary["max_total_elapsed_seconds"], 2.0)

    def test_runtime_status_from_health_distinguishes_loaded_and_unloaded(self):
        probe = load_probe_module()

        self.assertEqual(probe.runtime_status_from_health({"ok": True, "loaded": True}), "loaded")
        self.assertEqual(
            probe.runtime_status_from_health({"ok": True, "loaded": False}),
            "not_loaded",
        )
        self.assertEqual(probe.runtime_status_from_health({"ok": False}), "unhealthy")

    def test_iter_probe_cases_repeats_cases_in_stable_order(self):
        probe = load_probe_module()
        cases = [
            probe.ProbeCase(id="a", prompt="A"),
            probe.ProbeCase(id="b", prompt="B"),
        ]

        expanded = list(probe.iter_probe_cases(cases, repeat=2))

        self.assertEqual(
            [(run_index, case.id) for run_index, case in expanded],
            [(1, "a"), (1, "b"), (2, "a"), (2, "b")],
        )


if __name__ == "__main__":
    unittest.main()
