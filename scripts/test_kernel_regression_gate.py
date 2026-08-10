import os
import unittest

import scripts.kernel_regression_gate as gate


class KernelRegressionGateTests(unittest.TestCase):
    def test_default_plan_covers_kernel_regression_contracts(self):
        plan = gate.build_plan({})
        labels = [step.label for step in plan]

        self.assertEqual(plan[0].command, ["cargo", "fmt", "--check"])
        self.assertIn("task runtime turn lifecycle", labels)
        self.assertIn("task runtime turn reducer", labels)
        self.assertIn("turn consistency audit unit tests", labels)
        self.assertIn("task runtime active chat turn", labels)
        self.assertIn("task runtime finalizing fence", labels)
        self.assertIn("task runtime enqueue", labels)
        self.assertIn("gateway steering cleanup", labels)
        self.assertIn("desktop unit tests", labels)
        self.assertIn("desktop ui contract", labels)
        self.assertIn("desktop build", labels)
        self.assertNotIn("live gateway browser smoke", labels)

    def test_default_plan_keeps_commands_in_their_canonical_working_directory(self):
        by_label = {step.label: step for step in gate.build_plan({})}

        self.assertEqual(by_label["task runtime turn lifecycle"].cwd, gate.ROOT)
        self.assertEqual(
            by_label["task runtime turn reducer"].command,
            [
                "cargo",
                "test",
                "-p",
                "local-first-task-runtime",
                "--test",
                "turn_reducer_contract",
            ],
        )
        self.assertEqual(
            by_label["turn consistency audit unit tests"].command,
            [gate.PYTHON, "-m", "unittest", "scripts.test_audit_turn_consistency", "-v"],
        )
        self.assertEqual(by_label["gateway steering cleanup"].cwd, gate.ROOT)
        self.assertEqual(by_label["desktop unit tests"].command, ["npm", "test"])
        self.assertEqual(by_label["desktop unit tests"].cwd, gate.DESKTOP)
        self.assertEqual(by_label["desktop ui contract"].cwd, gate.DESKTOP)
        self.assertEqual(by_label["desktop build"].cwd, gate.DESKTOP)

    def test_live_smoke_is_opt_in_and_uses_gateway_inputs(self):
        plan = gate.build_plan(
            {
                "HOMUN_RUN_KERNEL_LIVE_SMOKE": "1",
                "HOMUN_GATEWAY_BASE": "http://127.0.0.1:18765",
                "HOMUN_DESKTOP_GATEWAY_TOKEN": "secret-token",
            }
        )

        step = plan[-1]
        self.assertEqual(step.label, "live gateway browser smoke")
        self.assertEqual(
            step.command,
            [
                gate.PYTHON,
                "scripts/kernel_live_smoke.py",
                "--gateway-base",
                "http://127.0.0.1:18765",
            ],
        )
        self.assertEqual(step.env["HOMUN_DESKTOP_GATEWAY_TOKEN"], "secret-token")

    def test_gate_stops_at_first_failed_step(self):
        calls = []

        def fake_run(step):
            calls.append(step.label)
            return step.label != "gateway steering cleanup"

        ok = gate.run_plan(gate.build_plan({}), fake_run)

        # The plan stops at the first failing step: everything before
        # "gateway steering cleanup" must have run, nothing after it.
        labels = [step.label for step in gate.build_plan({})]
        stop_index = labels.index("gateway steering cleanup")

        self.assertFalse(ok)
        self.assertEqual(calls, labels[: stop_index + 1])
        self.assertIn("gateway main ownership contract", calls)
        self.assertNotIn("desktop unit tests", calls)
        self.assertNotIn("desktop build", calls)


if __name__ == "__main__":
    os.chdir(os.path.dirname(os.path.dirname(__file__)))
    unittest.main()
