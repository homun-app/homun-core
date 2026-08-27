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
        self.assertIn("vault_identity_record", scenarios[2].setup)
        self.assertIn("smoke", scenarios[2].prompt.lower())
        self.assertIn("Italian locale", scenarios[8].name)
        self.assertIn("Italia", scenarios[8].prompt)
        self.assertIn("Text input", scenarios[5].require_text)
        self.assertIn("contained computer", scenarios[5].forbid_output)
        self.assertIn("contained computer", scenarios[6].forbid_output)
        self.assertIn("checkout_fixture", scenarios[7].setup)
        self.assertIn("browser", scenarios[7].domains)
        self.assertIn("Payment Approval Card", scenarios[7].prompt)

    def test_select_scenarios_filters_by_id(self):
        selected = smoke.select_scenarios(smoke.build_scenarios(), ["S1", "S3"])

        self.assertEqual([scenario.id for scenario in selected], ["S1", "S3"])

    def test_extended_profile_adds_complex_chat_automation_skill_and_memory_scenarios(self):
        baseline = smoke.build_scenarios()
        extended = smoke.build_scenarios(profile="extended")
        all_scenarios = smoke.build_scenarios(profile="all")

        self.assertEqual([scenario.id for scenario in baseline], [f"S{i}" for i in range(1, 10)])
        self.assertEqual([scenario.id for scenario in extended], ["X1", "X2", "X3"])
        self.assertEqual(
            [scenario.id for scenario in all_scenarios],
            [scenario.id for scenario in baseline + extended],
        )
        by_id = {scenario.id: scenario for scenario in extended}
        self.assertIn("automation", by_id["X1"].domains)
        self.assertIn("skill", by_id["X2"].domains)
        self.assertIn("memory", by_id["X3"].domains)
        self.assertIn("privacy", by_id["X3"].domains)

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
        self.assertTrue(
            smoke.status_allows_success("waitingUserApproval", scenario, "PAYMENT_APPROVAL")
        )
        self.assertTrue(
            smoke.status_allows_success("waitinguserapproval", scenario, "PAYMENT_APPROVAL")
        )
        self.assertTrue(
            smoke.status_allows_success(
                "completed",
                smoke.Scenario("SV", "vault", "ask", expect_marker="VAULT_PROPOSE"),
                '{"kind":"vault_propose","payload":{"pending_id":"p1"}}',
            )
        )
        self.assertTrue(smoke.status_allows_success("completed", scenario, "PAYMENT_APPROVAL"))
        self.assertFalse(smoke.status_allows_success("failed", scenario, "PAYMENT_APPROVAL"))
        self.assertFalse(smoke.status_allows_success("waiting_user_approval", scenario, ""))

    def test_vault_seed_setup_creates_real_record_before_turn(self):
        calls = []

        def fake_request(base, token, method, path, body=None, timeout=60):
            calls.append((method, path, body))
            if method == "GET" and path == "/api/vault/records":
                return 200, {"records": []}
            if method == "POST" and path == "/api/vault/proposals/accept":
                return 200, {
                    "ok": True,
                    "status": "created",
                    "record_id": "vault_smoke",
                    "category": "identity",
                    "label": "Codice fiscale smoke QA",
                    "redacted_preview": "[VAULT:identity:fiscal_code_smoke]",
                }
            raise AssertionError((method, path, body))

        original = smoke._request
        smoke._request = fake_request
        try:
            state = smoke.prepare_scenario("http://gateway", "token", smoke.build_scenarios()[2])
        finally:
            smoke._request = original

        self.assertEqual(state["vault_record_id"], "vault_smoke")
        accept = [call for call in calls if call[1] == "/api/vault/proposals/accept"][0]
        self.assertEqual(accept[2]["category"], "identity")
        self.assertIn("codice fiscale", accept[2]["label"].lower())
        self.assertNotIn(smoke.SMOKE_VAULT_SECRET, accept[2]["redacted_preview"])

    def test_vault_seed_cleanup_deletes_only_records_created_by_smoke(self):
        calls = []

        def fake_request(base, token, method, path, body=None, timeout=60):
            calls.append((method, path, body))
            return 200, {"ok": True}

        original = smoke._request
        smoke._request = fake_request
        try:
            smoke.cleanup_scenario(
                {
                    "base": "http://gateway",
                    "token": "token",
                    "vault_seeded": True,
                    "vault_record_id": "vault_smoke",
                }
            )
            smoke.cleanup_scenario(
                {
                    "base": "http://gateway",
                    "token": "token",
                    "vault_seeded": False,
                    "vault_record_id": "existing",
                }
            )
        finally:
            smoke._request = original

        self.assertEqual(calls, [("DELETE", "/api/vault/records/vault_smoke", None)])

    def test_checkout_fixture_setup_rewrites_prompt_to_public_checkout_url(self):
        scenario = next(item for item in smoke.build_scenarios() if item.id == "S8")
        state = smoke.prepare_scenario("http://gateway", "token", scenario)
        self.addCleanup(smoke.cleanup_scenario, state)

        self.assertIn("checkout_url", state)
        self.assertTrue(state["checkout_url"].startswith("https://"))
        self.assertNotIn("data:", state["checkout_url"])
        self.assertNotIn("127.0.0.1", state["checkout_url"])
        self.assertIn(state["checkout_url"], state["scenario"].prompt)

    def test_marker_success_still_rejects_browser_blocked_outputs(self):
        scenario = smoke.Scenario(
            "SY",
            "approval",
            "ask",
            expect_marker="PAYMENT_APPROVAL",
            forbid_output=("BROWSER_NAVIGATION_BLOCKED", "browser_budget_exceeded"),
        )

        self.assertFalse(
            smoke.status_allows_success(
                "completed",
                scenario,
                "BROWSER_NAVIGATION_BLOCKED ‹‹PAYMENT_APPROVAL››{}‹‹/PAYMENT_APPROVAL››",
            )
        )


if __name__ == "__main__":
    unittest.main()
