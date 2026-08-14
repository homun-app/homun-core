import unittest

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


if __name__ == "__main__":
    unittest.main()
