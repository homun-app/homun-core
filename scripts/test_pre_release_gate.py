import os
import unittest

import scripts.pre_release_gate as gate


class PreReleaseGateTests(unittest.TestCase):
    def test_default_plan_runs_deterministic_local_checks_only(self):
        plan = gate.build_plan({})

        labels = [step.label for step in plan]

        self.assertIn("capability tests", labels)
        self.assertIn("orchestrator tests", labels)
        self.assertIn("gateway tests", labels)
        self.assertIn("ui contract", labels)
        self.assertIn("desktop build", labels)
        self.assertIn("eval unit tests", labels)
        self.assertIn("eval syntax", labels)
        self.assertNotIn("model eval", labels)
        self.assertNotIn("gateway eval", labels)

    def test_env_enables_model_and_gateway_eval(self):
        env = {
            "HOMUN_RUN_MODEL_EVAL": "1",
            "HOMUN_EVAL_MODEL": "gemma4:latest",
            "HOMUN_EVAL_RUNS": "2",
            "HOMUN_EVAL_GATEWAY_BASE": "http://127.0.0.1:18765",
            "HOMUN_EVAL_GATEWAY_TOKEN": "secret-token",
            "HOMUN_RUN_PRODUCTION_SMOKE": "1",
        }

        plan = gate.build_plan(env)
        by_label = {step.label: step for step in plan}

        self.assertEqual(
            by_label["model eval"].command,
            [gate.PYTHON, "scripts/eval_suite.py", "gemma4:latest", "2"],
        )
        self.assertEqual(
            by_label["gateway eval"].command,
            [gate.PYTHON, "-c", gate.GATEWAY_EVAL_SNIPPET],
        )
        self.assertEqual(by_label["gateway eval"].env["HOMUN_EVAL_GATEWAY_TOKEN"], "secret-token")
        self.assertEqual(
            by_label["production smoke"].command,
            [gate.PYTHON, "scripts/production_smoke.py", "--gateway-base", "http://127.0.0.1:18765"],
        )
        self.assertEqual(by_label["production smoke"].env["HOMUN_EVAL_GATEWAY_TOKEN"], "secret-token")

    def test_gate_stops_at_first_failed_step(self):
        calls = []

        def fake_run(step):
            calls.append(step.label)
            return step.label != "ui contract"

        ok = gate.run_plan(gate.build_plan({}), fake_run)

        self.assertFalse(ok)
        self.assertEqual(calls, ["capability tests", "orchestrator tests", "gateway tests", "ui contract"])


if __name__ == "__main__":
    os.chdir(os.path.dirname(os.path.dirname(__file__)))
    unittest.main()
