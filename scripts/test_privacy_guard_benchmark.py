import unittest

from scripts.privacy_guard_benchmark import score


class PrivacyGuardBenchmarkScoreTests(unittest.TestCase):
    def test_score_requires_quality_and_latency(self):
        result = score(
            [True, True, False],
            [True, True, True],
            [1_000.0, 2_000.0, 20_000.0],
            valid_json=3,
        )

        self.assertFalse(result["qualified"])
        self.assertLess(result["specificity"], 0.90)
        self.assertGreater(result["p95_ms"], 12_000)

    def test_score_qualifies_only_when_every_threshold_passes(self):
        expected = [True] * 20 + [False] * 20
        predicted = expected.copy()
        result = score(expected, predicted, [500.0] * 40, valid_json=40)

        self.assertTrue(result["qualified"])
        self.assertEqual(result["recall"], 1.0)
        self.assertEqual(result["specificity"], 1.0)
        self.assertEqual(result["valid_json"], 1.0)


if __name__ == "__main__":
    unittest.main()
