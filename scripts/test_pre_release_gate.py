import os
import unittest

import scripts.pre_release_gate as gate


class PreReleaseGateTests(unittest.TestCase):
    def test_stability_steps_are_required(self):
        plan = gate.build_plan({})
        labels = [step.label for step in plan]
        by_label = {step.label: step for step in plan}

        self.assertIn("rust format", labels)
        self.assertIn("rust clippy", labels)
        self.assertIn("desktop dependency install", labels)
        self.assertIn("desktop dependency audit", labels)
        self.assertIn("browser automation dependency audit", labels)
        self.assertIn("task runtime tests", labels)
        self.assertIn("turn consistency audit unit tests", labels)
        self.assertIn("kernel projection smoke", labels)
        self.assertIn("scripts.test_e2e_browser_diagnostic", by_label["eval unit tests"].command)
        self.assertIn("scripts.test_audit_homun_state", by_label["eval unit tests"].command)
        self.assertIn("scripts.test_clean_runtime_smoke", by_label["eval unit tests"].command)
        self.assertIn("engine tests", labels)
        self.assertIn("desktop unit tests", labels)
        self.assertIn("stability soak unit tests", labels)

    def test_desktop_unit_tests_use_the_umbrella_route(self):
        by_label = {step.label: step for step in gate.build_plan({})}

        step = by_label["desktop unit tests"]
        self.assertEqual(step.command, ["npm", "test"])
        self.assertEqual(step.cwd, gate.DESKTOP)

    def test_live_stability_soak_is_last_when_enabled(self):
        plan = gate.build_plan({"HOMUN_RUN_STABILITY_SOAK": "1"})

        self.assertEqual(plan[-1].label, "live stability soak")
        self.assertEqual(
            plan[-1].command,
            [gate.PYTHON, "scripts/stability_soak.py", "--hard-restart"],
        )

    def test_default_plan_runs_deterministic_local_checks_only(self):
        plan = gate.build_plan({})

        labels = [step.label for step in plan]

        self.assertEqual(
            plan[0].command,
            ["cargo", "fmt", "--all", "--", "--check"],
        )
        self.assertEqual(
            plan[1].command,
            [gate.PYTHON, "scripts/check_gateway_main_contract.py"],
        )
        self.assertEqual(
            plan[2].command,
            [
                "cargo",
                "clippy",
                "--workspace",
                "--all-targets",
                "--locked",
                "--",
                "-D",
                "warnings",
            ],
        )
        self.assertEqual(plan[3].command, ["npm", "ci"])
        self.assertEqual(plan[3].cwd, gate.DESKTOP)
        self.assertEqual(plan[4].command, ["npm", "audit", "--audit-level=high"])
        self.assertEqual(plan[4].cwd, gate.DESKTOP)
        self.assertEqual(plan[5].command, ["npm", "audit", "--audit-level=high"])
        self.assertEqual(plan[5].cwd, gate.BROWSER_AUTOMATION)
        self.assertIn("capability tests", labels)
        self.assertIn("orchestrator tests", labels)
        self.assertIn("gateway tests", labels)
        self.assertIn("memorybench provider", labels)
        self.assertIn("kernel projection smoke", labels)
        self.assertIn("ui contract", labels)
        self.assertIn("desktop build", labels)
        self.assertIn("eval unit tests", labels)
        self.assertIn("eval syntax", labels)
        self.assertNotIn("model eval", labels)
        self.assertNotIn("gateway eval", labels)
        by_label = {step.label: step for step in plan}
        self.assertIn("scripts.test_kernel_regression_gate", by_label["eval unit tests"].command)
        self.assertIn("scripts.test_smoke_kernel_projection", by_label["eval unit tests"].command)
        self.assertIn("scripts.test_e2e_browser_diagnostic", by_label["eval unit tests"].command)
        self.assertIn("scripts.test_audit_homun_state", by_label["eval unit tests"].command)

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
        self.assertEqual(
            calls,
            [
                "rust format",
                "gateway main ownership contract",
                "rust clippy",
                "desktop dependency install",
                "desktop dependency audit",
                "browser automation dependency audit",
                "capability tests",
                "orchestrator tests",
                "task runtime tests",
                "turn consistency audit unit tests",
                "kernel projection smoke",
                "engine tests",
                "gateway tests",
                "memorybench provider",
                "desktop unit tests",
                "ui contract",
            ],
        )


if __name__ == "__main__":
    os.chdir(os.path.dirname(os.path.dirname(__file__)))
    unittest.main()
