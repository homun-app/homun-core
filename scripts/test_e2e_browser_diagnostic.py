import unittest
from unittest.mock import patch

import scripts.e2e_browser_diagnostic as diagnostic


class E2EBrowserDiagnosticTests(unittest.TestCase):
    def test_final_result_fails_when_projection_browser_failed(self):
        projection = {
            "browser": {
                "state": "failed",
                "failure_reason": "unknown",
            },
            "plan": {
                "steps": [
                    {"id": "s1", "status": "done"},
                    {"id": "s2", "status": "blocked"},
                ]
            },
        }

        passed, sample = diagnostic.evaluate_final_result(
            ["Riprovo subito a completare la ricerca sulla stessa pagina."],
            projection,
        )

        self.assertFalse(passed)
        self.assertIn("browser failed", sample)

    def test_final_result_fails_when_plan_has_blocked_step(self):
        projection = {
            "browser": {"state": "idle"},
            "plan": {
                "steps": [
                    {"id": "s1", "status": "done"},
                    {"id": "s2", "status": "blocked", "title": "Leggere risultati"},
                ]
            },
        }

        passed, sample = diagnostic.evaluate_final_result(
            ["Ecco le opzioni trovate."],
            projection,
        )

        self.assertFalse(passed)
        self.assertIn("blocked", sample)

    def test_final_result_passes_with_message_and_clean_projection(self):
        projection = {
            "browser": {"state": "done"},
            "plan": {"steps": [{"id": "s1", "status": "done"}]},
        }

        passed, sample = diagnostic.evaluate_final_result(
            ["Opzione 1: treno FR 9512 alle 09:05."],
            projection,
        )

        self.assertTrue(passed)
        self.assertIn("msgs=1", sample)

    def test_final_result_fails_on_ready_placeholder(self):
        projection = {
            "browser": {"state": "done"},
            "plan": {"steps": [{"id": "s1", "status": "done"}]},
        }

        passed, sample = diagnostic.evaluate_final_result(
            ["I'm ready. Give me the task and I will continue."],
            projection,
        )

        self.assertFalse(passed)
        self.assertIn("placeholder", sample)

    def test_assistant_texts_prefer_current_turn_linked_message(self):
        queries = []

        def fake_db_query(sql, params=()):
            queries.append((sql, params))
            if "linked_task_id=?" in sql:
                return [{"text": "Risposta del turn corrente con risultati treno."}]
            if "role='assistant'" in sql:
                return [{"text": "I'm ready. Give me the task and I will continue."}]
            return []

        with patch.object(diagnostic, "db_query", side_effect=fake_db_query):
            texts = diagnostic.get_assistant_texts("thread-1", "turn-1")

        self.assertEqual(texts, ["Risposta del turn corrente con risultati treno."])
        self.assertEqual(queries[0][1], ("thread-1", "turn-1"))


if __name__ == "__main__":
    unittest.main()
