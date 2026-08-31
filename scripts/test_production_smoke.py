import unittest
from unittest import mock

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
        self.assertGreaterEqual(scenarios[8].max_seconds, 600)
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
        self.assertEqual([scenario.id for scenario in extended], ["X1", "X2", "X3", "X4", "X5", "X6"])
        self.assertEqual(
            [scenario.id for scenario in all_scenarios],
            [scenario.id for scenario in baseline + extended],
        )
        by_id = {scenario.id: scenario for scenario in extended}
        self.assertIn("automation", by_id["X1"].domains)
        self.assertIn("temp_automation_workspace", by_id["X1"].setup)
        self.assertIn("skill", by_id["X2"].domains)
        self.assertIn("memory", by_id["X3"].domains)
        self.assertIn("privacy", by_id["X3"].domains)
        self.assertIn("code", by_id["X4"].domains)
        self.assertIn("temp_code_workspace", by_id["X4"].setup)
        self.assertIn("CODE_CONTEXT_OK", by_id["X4"].require_text)
        self.assertIn("automation", by_id["X5"].domains)
        self.assertEqual(by_id["X5"].runner, "automation_api")
        self.assertIn("mcp", by_id["X6"].domains)
        self.assertEqual(by_id["X6"].runner, "mcp_stdio_api")

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

    def test_create_thread_scopes_to_workspace_when_setup_provides_one(self):
        calls = []

        def fake_request(base, token, method, path, body=None, timeout=60):
            calls.append((method, path, body))
            return 200, {"thread_id": "thread-code"}

        original = smoke._request
        smoke._request = fake_request
        try:
            thread_id = smoke.create_thread("http://gateway", "token", "smoke X4", "workspace_code")
        finally:
            smoke._request = original

        self.assertEqual(thread_id, "thread-code")
        self.assertEqual(calls, [("POST", "/api/chat/threads?workspace=workspace_code", {"title": "smoke X4"})])

    def test_status_success_requires_completed_for_plain_scenarios(self):
        scenario = smoke.Scenario("SX", "plain", "Rispondi ok")

        self.assertTrue(smoke.status_allows_success("completed", scenario, "anything"))
        self.assertFalse(smoke.status_allows_success("failed", scenario, "anything"))
        self.assertFalse(smoke.status_allows_success("suspended", scenario, "anything"))

    def test_x3_allows_secret_word_in_explicit_negative_statement(self):
        scenario = next(item for item in smoke.build_scenarios(profile="extended") if item.id == "X3")

        self.assertTrue(
            smoke.status_allows_success(
                "completed",
                scenario,
                "Ho salvato la preferenza: report brevi. Nessun dato personale ne' segreto.",
            )
        )

    def test_browser_scenarios_require_semantic_success_not_just_completed_status(self):
        s6 = next(scenario for scenario in smoke.build_scenarios() if scenario.id == "S6")
        success = 'Fatto: Text input contiene "smoke" sulla pagina.'
        browser_unavailable = (
            "Non ho potuto completare il task: il browser non è disponibile "
            "perché il contained computer non è in esecuzione."
        )
        browser_timeout = (
            "Il tentativo non è riuscito: BROWSER_SIDECAR_TIMEOUT. "
            "Non ho quindi potuto compilare Text input con smoke."
        )

        self.assertTrue(smoke.status_allows_success("completed", s6, success))
        self.assertFalse(smoke.status_allows_success("completed", s6, browser_unavailable))
        self.assertFalse(smoke.status_allows_success("completed", s6, browser_timeout))
        self.assertFalse(smoke.status_allows_success("completed", s6, "Fatto ma senza evidenza"))

    def test_web_discovery_scenarios_reject_partial_one_item_answers(self):
        s9 = next(scenario for scenario in smoke.build_scenarios() if scenario.id == "S9")

        self.assertFalse(
            smoke.status_allows_success(
                "completed",
                s9,
                "Risultato parziale: sono riuscito a estrarre solo 1 notizia tech di oggi, non 3.",
            )
        )
        self.assertFalse(
            smoke.status_allows_success(
                "completed",
                s9,
                (
                    "1. Fonte: https://www.trenitalia.com/it.html\n"
                    "2. Come procedere\n"
                    "3. Sources\n"
                    "Non ho ancora dati verificati da riportarti: la ricerca non e' andata "
                    "a buon fine. La ricerca pero' e' andata in timeout prima che la lista "
                    "dei risultati venisse caricata."
                ),
            )
        )

    def test_wait_turn_output_retries_transient_turn_not_found(self):
        calls = []

        def fake_request(base, token, method, path, body=None, timeout=60):
            calls.append(path)
            if path == "/api/chat/turns/turn-1" and calls.count(path) == 1:
                raise RuntimeError(
                    'HTTP 404 /api/chat/turns/turn-1: {"error":{"code":"turn_not_found"}}'
                )
            if path == "/api/chat/turns/turn-1":
                return 200, {"status": "completed"}
            if path == "/api/chat/turns/turn-1/events?since=0":
                return 200, [{"text": "done"}]
            raise AssertionError(path)

        original_sleep = smoke.time.sleep
        original_request = smoke._request
        smoke.time.sleep = lambda _seconds: None
        smoke._request = fake_request
        try:
            status, output, _elapsed = smoke.wait_turn_output(
                "http://gateway",
                "token",
                "turn-1",
                2,
            )
        finally:
            smoke._request = original_request
            smoke.time.sleep = original_sleep

        self.assertEqual(status, "completed")
        self.assertIn("done", output)

    def test_wait_turn_output_does_not_stop_on_marker_before_terminal_status(self):
        status_calls = 0

        def fake_request(base, token, method, path, body=None, timeout=60):
            nonlocal status_calls
            if path == "/api/chat/turns/turn-1":
                status_calls += 1
                return 200, {"status": "running" if status_calls == 1 else "completed"}
            if path == "/api/chat/turns/turn-1/events?since=0":
                return 200, [{"kind": "vault_reveal", "payload": {"record_id": "vault_smoke"}}]
            raise AssertionError(path)

        original_sleep = smoke.time.sleep
        original_request = smoke._request
        smoke.time.sleep = lambda _seconds: None
        smoke._request = fake_request
        try:
            status, output, _elapsed = smoke.wait_turn_output(
                "http://gateway",
                "token",
                "turn-1",
                2,
            )
        finally:
            smoke._request = original_request
            smoke.time.sleep = original_sleep

        self.assertEqual(status, "completed")
        self.assertIn("vault_smoke", output)

    def test_wait_turn_output_reads_once_at_deadline_before_returning_running(self):
        status_calls = 0
        times = iter([100.0, 100.0, 100.0, 102.1, 102.1])

        def fake_time():
            return next(times, 102.1)

        def fake_request(base, token, method, path, body=None, timeout=60):
            nonlocal status_calls
            if path == "/api/chat/turns/turn-1":
                status_calls += 1
                return 200, {"status": "running" if status_calls == 1 else "waiting_user"}
            if path == "/api/chat/turns/turn-1/events?since=0":
                return 200, [{"kind": "choice_prompt", "payload": {"question": "Continue?"}}]
            raise AssertionError(path)

        original_sleep = smoke.time.sleep
        original_time = smoke.time.time
        original_request = smoke._request
        smoke.time.sleep = lambda _seconds: None
        smoke.time.time = fake_time
        smoke._request = fake_request
        try:
            status, output, _elapsed = smoke.wait_turn_output(
                "http://gateway",
                "token",
                "turn-1",
                2,
            )
        finally:
            smoke._request = original_request
            smoke.time.time = original_time
            smoke.time.sleep = original_sleep

        self.assertEqual(status, "waiting_user")
        self.assertIn("Continue?", output)

    def test_wait_turn_output_scopes_polling_to_workspace(self):
        calls = []

        def fake_request(base, token, method, path, body=None, timeout=60):
            calls.append(path)
            if path == "/api/chat/turns/turn-1?workspace=workspace_code":
                return 200, {"status": "completed"}
            if path == "/api/chat/turns/turn-1/events?since=0&workspace=workspace_code":
                return 200, [{"text": "CODE_CONTEXT_OK add_numbers 5"}]
            raise AssertionError(path)

        original_request = smoke._request
        smoke._request = fake_request
        try:
            status, output, _elapsed = smoke.wait_turn_output(
                "http://gateway",
                "token",
                "turn-1",
                2,
                "workspace_code",
            )
        finally:
            smoke._request = original_request

        self.assertEqual(status, "completed")
        self.assertIn("CODE_CONTEXT_OK", output)

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

    def test_temp_code_workspace_setup_creates_workspace_and_cleans_it(self):
        calls = []

        def fake_request(base, token, method, path, body=None, timeout=60):
            calls.append((method, path, body))
            if method == "POST" and path == "/api/workspaces":
                return 200, {
                    "active_workspace_id": "default",
                    "workspaces": [
                        {"id": "workspace_code", "name": body["name"], "folder": body["folder"]}
                    ],
                }
            if method == "POST" and path == "/api/workspaces/workspace_code/delete":
                return 200, {"active_workspace_id": "default", "workspaces": []}
            raise AssertionError((method, path, body))

        scenario = next(item for item in smoke.build_scenarios(profile="extended") if item.id == "X4")
        original = smoke._request
        smoke._request = fake_request
        try:
            with mock.patch("scripts.production_smoke.shutil.rmtree") as rmtree:
                state = smoke.prepare_scenario("http://gateway", "token", scenario)
                self.assertEqual(state["workspace_id"], "workspace_code")
                self.assertIn("CODE_CONTEXT_OK", state["scenario"].prompt)
                self.assertIn(state["project_root"], state["scenario"].prompt)
                smoke.cleanup_scenario(state, scenario_passed=True)
                rmtree.assert_called_once_with(state["project_root"], ignore_errors=True)
        finally:
            smoke._request = original

        self.assertEqual(calls[0][0:2], ("POST", "/api/workspaces"))
        self.assertEqual(calls[-1][0:2], ("POST", "/api/workspaces/workspace_code/delete"))

    def test_temp_code_workspace_cleanup_preserves_fixture_on_failure(self):
        calls = []

        def fake_request(base, token, method, path, body=None, timeout=60):
            calls.append((method, path, body))
            return 200, {}

        original = smoke._request
        smoke._request = fake_request
        try:
            with mock.patch("scripts.production_smoke.shutil.rmtree") as rmtree:
                smoke.cleanup_scenario(
                    {
                        "base": "http://gateway",
                        "token": "token",
                        "workspace_id": "workspace_code",
                        "temp_project_root": "/tmp/homun-code-smoke-x",
                    },
                    scenario_passed=False,
                )
                rmtree.assert_not_called()
        finally:
            smoke._request = original

        self.assertEqual(calls, [])

    def test_smoke_thread_cleanup_deletes_created_thread_on_success(self):
        calls = []

        def fake_request(base, token, method, path, body=None, timeout=60):
            calls.append((method, path, body))
            return 200, {}

        original = smoke._request
        smoke._request = fake_request
        try:
            smoke.cleanup_scenario(
                {
                    "base": "http://gateway",
                    "token": "token",
                    "thread_id": "thread_smoke",
                },
                scenario_passed=True,
            )
        finally:
            smoke._request = original

        self.assertEqual(calls, [("DELETE", "/api/chat/threads/thread_smoke", None)])

    def test_smoke_thread_cleanup_preserves_created_thread_on_failure(self):
        calls = []

        def fake_request(base, token, method, path, body=None, timeout=60):
            calls.append((method, path, body))
            return 200, {}

        original = smoke._request
        smoke._request = fake_request
        try:
            smoke.cleanup_scenario(
                {
                    "base": "http://gateway",
                    "token": "token",
                    "thread_id": "thread_smoke",
                },
                scenario_passed=False,
            )
        finally:
            smoke._request = original

        self.assertEqual(calls, [])

    def test_smoke_turn_cleanup_cancels_nonterminal_failed_scenario(self):
        calls = []

        def fake_request(base, token, method, path, body=None, timeout=60):
            calls.append((method, path, body))
            return 200, {}

        original = smoke._request
        smoke._request = fake_request
        try:
            smoke.cleanup_scenario(
                {
                    "base": "http://gateway",
                    "token": "token",
                    "thread_id": "thread_smoke",
                    "turn_id": "turn smoke/id",
                    "last_status": "running",
                },
                scenario_passed=False,
            )
        finally:
            smoke._request = original

        self.assertEqual(calls, [("POST", "/api/tasks/turn%20smoke%2Fid/cancel", None)])

    def test_automation_api_lifecycle_uses_scoped_crud_and_cleanup(self):
        calls = []
        auto_id = "auto_smoke"
        list_calls = 0

        def fake_request(base, token, method, path, body=None, timeout=60):
            nonlocal list_calls
            calls.append((method, path, body))
            if method == "POST" and path == "/api/workspaces":
                return 200, {
                    "workspaces": [
                        {"id": "workspace_auto", "name": body["name"], "folder": body["folder"]}
                    ],
                }
            if method == "POST" and path == "/api/automations/dry-run":
                self.assertEqual(body["workspace_id"], "workspace_auto")
                return 200, {
                    "valid": True,
                    "workspace_id": "workspace_auto",
                    "trigger_kind": "schedule",
                    "approval": "confirm",
                    "source": "manual",
                    "would_create_automation": True,
                    "would_materialize_task": True,
                    "next_run": 1_782_000_000,
                }
            if method == "POST" and path == "/api/automations":
                self.assertEqual(body["workspace_id"], "workspace_auto")
                return 200, {
                    "id": auto_id,
                    "workspace_id": "workspace_auto",
                    "enabled": True,
                    "task_id": "autorun_smoke",
                    "next_run": 1_782_000_000,
                    "approval": "confirm",
                }
            if method == "GET" and path == "/api/automations?workspace_id=workspace_auto":
                list_calls += 1
                if list_calls == 1:
                    return 200, {"automations": []}
                if list_calls == 2:
                    return 200, {
                        "automations": [
                            {"id": auto_id, "workspace_id": "workspace_auto"},
                        ]
                    }
                return 200, {"automations": []}
            if method == "POST" and path == "/api/automations/auto_smoke/toggle?workspace_id=workspace_auto":
                return 200, {
                    "id": auto_id,
                    "workspace_id": "workspace_auto",
                    "enabled": False,
                    "task_id": None,
                }
            if method == "DELETE" and path == "/api/automations/auto_smoke?workspace_id=workspace_auto":
                return 200, {"deleted": auto_id}
            if method == "POST" and path == "/api/workspaces/workspace_auto/delete":
                return 200, {"workspaces": []}
            raise AssertionError((method, path, body))

        original_request = smoke._request
        smoke._request = fake_request
        try:
            with mock.patch("scripts.production_smoke.shutil.rmtree") as rmtree:
                status, output, _elapsed, state = smoke.run_automation_api_lifecycle(
                    "http://gateway",
                    "token",
                )
                self.assertEqual(status, "completed")
                self.assertIn("automation_api_lifecycle ok", output)
                smoke.cleanup_scenario(state, scenario_passed=True)
                rmtree.assert_called_once_with(state["temp_project_root"], ignore_errors=True)
        finally:
            smoke._request = original_request

        self.assertIn(("POST", "/api/automations/dry-run", mock.ANY), calls)
        self.assertIn(("DELETE", "/api/automations/auto_smoke?workspace_id=workspace_auto", None), calls)
        self.assertEqual(calls[-1][0:2], ("POST", "/api/workspaces/workspace_auto/delete"))

    def test_mcp_stdio_lifecycle_connects_lists_and_disconnects_scoped_server(self):
        calls = []

        def fake_request(base, token, method, path, body=None, timeout=60):
            calls.append((method, path, body))
            if method == "POST" and path == "/api/workspaces":
                return 200, {
                    "workspaces": [
                        {"id": "workspace_mcp", "name": body["name"], "folder": body["folder"]}
                    ],
                }
            if method == "POST" and path == "/api/capabilities/mcp/connect?workspace=workspace_mcp":
                self.assertEqual(body["name"], "homun smoke mcp")
                self.assertTrue(body["command"].endswith("fake_mcp_stdio"))
                return 200, {
                    "provider_id": "mcp:homun-smoke-mcp",
                    "connection_id": "mcp-homun-smoke-mcp",
                    "tools_cached": 1,
                    "discovery_error": None,
                }
            if method == "GET" and path == "/api/capabilities/mcp/connected?workspace=workspace_mcp":
                return 200, {
                    "servers": [
                        {"provider_id": "mcp:homun-smoke-mcp", "name": "homun smoke mcp", "tools": 1}
                    ]
                }
            if method == "POST" and path == "/api/capabilities/mcp/disconnect?workspace=workspace_mcp":
                self.assertEqual(body["provider_id"], "mcp:homun-smoke-mcp")
                return 200, {"removed": True}
            if method == "POST" and path == "/api/workspaces/workspace_mcp/delete":
                return 200, {"workspaces": []}
            raise AssertionError((method, path, body))

        original_request = smoke._request
        smoke._request = fake_request
        try:
            with mock.patch("scripts.production_smoke.shutil.rmtree") as rmtree:
                status, output, _elapsed, state = smoke.run_mcp_stdio_lifecycle(
                    "http://gateway",
                    "token",
                    "/tmp/fake_mcp_stdio",
                )
                self.assertEqual(status, "completed")
                self.assertIn("mcp_stdio_lifecycle ok", output)
                smoke.cleanup_scenario(state, scenario_passed=True)
                rmtree.assert_called_once_with(state["temp_project_root"], ignore_errors=True)
        finally:
            smoke._request = original_request

        self.assertIn(
            ("POST", "/api/capabilities/mcp/disconnect?workspace=workspace_mcp", {"provider_id": "mcp:homun-smoke-mcp"}),
            calls,
        )
        self.assertEqual(calls[-1][0:2], ("POST", "/api/workspaces/workspace_mcp/delete"))

    def test_checkout_fixture_setup_rewrites_prompt_to_public_checkout_url(self):
        scenario = next(item for item in smoke.build_scenarios() if item.id == "S8")
        state = smoke.prepare_scenario("http://gateway", "token", scenario)
        self.addCleanup(smoke.cleanup_scenario, state)

        self.assertIn("checkout_url", state)
        self.assertTrue(state["checkout_url"].startswith("https://"))
        self.assertNotIn("data:", state["checkout_url"])
        self.assertNotIn("127.0.0.1", state["checkout_url"])
        self.assertIn("checkout.stripe.dev", state["checkout_url"])
        self.assertIn(state["checkout_url"], state["scenario"].prompt)
        self.assertIn("non compilare campi carta/CVV", state["scenario"].prompt)

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
