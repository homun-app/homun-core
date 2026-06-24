import os
import unittest
from unittest import mock

import scripts.eval_suite as eval_suite


class EvalSuiteTests(unittest.TestCase):
    def test_gateway_template_validator_requires_read_only_previewed_templates(self):
        ok, reason = eval_suite.v_gateway_templates(
            {
                "templates": [
                    {
                        "id": "monet/startup-pitch-clean-01",
                        "preview_ref": "builtin:template-preview/monet/startup-pitch-clean-01",
                    }
                ]
            }
        )
        self.assertTrue(ok, reason)

        ok, reason = eval_suite.v_gateway_templates(
            {
                "templates": [
                    {
                        "id": "monet/startup-pitch-clean-01",
                        "preview_ref": "builtin:template-preview/monet/startup-pitch-clean-01",
                        "schema": {"type": "object"},
                    }
                ]
            }
        )
        self.assertFalse(ok)
        self.assertIn("callable", reason)

    def test_gateway_capabilities_validator_requires_policy_and_arrays(self):
        ok, reason = eval_suite.v_gateway_capabilities(
            {
                "connections": [],
                "tools": [
                    {
                        "provider_id": "mcp:filesystem",
                        "name": "mcp__filesystem__read_file",
                        "provider_kind": "mcp",
                        "action": "read",
                        "description": "Read a file",
                    }
                ],
                "policy": {"enabled_providers": [], "allow_managed_cloud": False},
            }
        )
        self.assertTrue(ok, reason)

        ok, reason = eval_suite.v_gateway_capabilities(
            {"connections": [], "tools": [], "policy": {"allow_managed_cloud": False}}
        )
        self.assertFalse(ok)
        self.assertIn("policy", reason)

        ok, reason = eval_suite.v_gateway_capabilities(
            {
                "connections": [],
                "tools": [{"name": "missing-contract"}],
                "policy": {"enabled_providers": [], "allow_managed_cloud": False},
            }
        )
        self.assertFalse(ok)
        self.assertIn("tool contract", reason)

    def test_gateway_checks_fail_closed_on_bad_contract(self):
        with mock.patch.object(eval_suite, "GATEWAY_BASE", "http://127.0.0.1:18765"):
            with mock.patch.object(
                eval_suite,
                "gateway_get",
                return_value=(200, {"templates": [{"id": "wrong"}]}),
            ):
                self.assertFalse(eval_suite.run_gateway_checks())


if __name__ == "__main__":
    os.chdir(os.path.dirname(os.path.dirname(__file__)))
    unittest.main()
