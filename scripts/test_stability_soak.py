import unittest

from scripts.stability_soak import evaluate


class StabilitySoakTest(unittest.TestCase):
    def test_rejects_focus_change_duplicate_terminal_and_reasoning(self):
        result = evaluate(
            [
                {"thread": "b", "kind": "selected"},
                {"thread": "a", "kind": "selected"},
                {"thread": "a", "kind": "done", "assistant_id": "x"},
                {
                    "thread": "a",
                    "kind": "done",
                    "assistant_id": "y",
                    "text": "‹‹REASONING››raw",
                },
            ],
            expected_selected="b",
        )
        self.assertFalse(result["passed"])
        self.assertIn("focus_changed", result["violations"])
        self.assertIn("duplicate_terminal", result["violations"])
        self.assertIn("reasoning_leak", result["violations"])

    def test_accepts_out_of_order_background_completions(self):
        result = evaluate(
            [
                {"thread": "b", "kind": "selected"},
                {"thread": "c", "turn": "c1", "kind": "done", "assistant_id": "c-a"},
                {"thread": "a", "turn": "a1", "kind": "done", "assistant_id": "a-a"},
                {"thread": "b", "turn": "b1", "kind": "done", "assistant_id": "b-a"},
            ],
            expected_selected="b",
        )
        self.assertTrue(result["passed"])
        self.assertEqual(result["violations"], [])


if __name__ == "__main__":
    unittest.main()
