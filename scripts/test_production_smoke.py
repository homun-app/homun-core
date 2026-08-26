import unittest

import scripts.production_smoke as smoke


class ProductionSmokeTests(unittest.TestCase):
    def test_default_scenarios_cover_production_baseline(self):
        scenarios = smoke.build_scenarios()
        ids = [scenario.id for scenario in scenarios]

        self.assertEqual(
            ids,
            [
                "S1",
                "S2",
                "S3",
                "S4",
                "S5",
                "S6",
                "S7",
                "S8",
                "S9",
            ],
        )
        self.assertIn("Vault", scenarios[2].name)
        self.assertTrue(scenarios[2].expect_marker)
        self.assertTrue(scenarios[2].forbid_plaintext)
        self.assertIn("Italian locale", scenarios[8].name)
        self.assertIn("Italia", scenarios[8].prompt)
        self.assertIn("Text input", scenarios[5].require_text)
        self.assertIn("contained computer", scenarios[5].forbid_output)
        self.assertIn("contained computer", scenarios[6].forbid_output)

    def test_select_scenarios_filters_by_id(self):
        selected = smoke.select_scenarios(smoke.build_scenarios(), ["S1", "S3"])

        self.assertEqual([scenario.id for scenario in selected], ["S1", "S3"])

    def test_broker_helpers_are_exported(self):
        # Guard the live path: smoke must use turns broker, not generate_stream.
        source = smoke.__file__
        self.assertTrue(source)
        with open(source, encoding="utf-8") as handle:
            text = handle.read()
        self.assertIn("/api/chat/turns", text)
        self.assertIn("/api/chat/threads", text)
        body = text.split('"""', 2)[-1]
        self.assertNotIn("/api/chat/generate_stream", body)
        self.assertTrue(callable(smoke.create_thread))
        self.assertTrue(callable(smoke.enqueue_turn))
        self.assertTrue(callable(smoke.run_turn_via_broker))

    def test_status_success_requires_completed_for_plain_scenarios(self):
        scenario = smoke.Scenario("SX", "plain", "Rispondi ok")

        self.assertTrue(smoke.status_allows_success("completed", scenario, "anything"))
        self.assertFalse(smoke.status_allows_success("failed", scenario, "anything"))
        self.assertFalse(smoke.status_allows_success("suspended", scenario, "anything"))

    def test_browser_scenarios_require_semantic_success_not_just_completed_status(self):
        s6 = next(scenario for scenario in smoke.build_scenarios() if scenario.id == "S6")
        success = 'Fatto: Text input contiene "smoke" sulla pagina.'
        browser_unavailable = (
            "Non ho potuto completare il task: il browser non è disponibile "
            "perché il contained computer non è in esecuzione."
        )

        self.assertTrue(smoke.status_allows_success("completed", s6, success))
        self.assertFalse(smoke.status_allows_success("completed", s6, browser_unavailable))
        self.assertFalse(smoke.status_allows_success("completed", s6, "Fatto ma senza evidenza"))

    def test_marker_scenarios_require_marker_and_wait_or_completed_status(self):
        scenario = smoke.Scenario("SY", "approval", "ask", expect_marker="PAYMENT_APPROVAL")

        self.assertTrue(
            smoke.status_allows_success("waiting_user_approval", scenario, "PAYMENT_APPROVAL")
        )
        self.assertTrue(smoke.status_allows_success("completed", scenario, "PAYMENT_APPROVAL"))
        self.assertFalse(smoke.status_allows_success("failed", scenario, "PAYMENT_APPROVAL"))
        self.assertFalse(smoke.status_allows_success("waiting_user_approval", scenario, ""))


if __name__ == "__main__":
    unittest.main()
