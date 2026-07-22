import unittest
from unittest import mock

from scripts.privacy_guard_benchmark import classify_case, score


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

    @mock.patch("scripts.privacy_guard_benchmark.urllib.request.urlopen")
    def test_socket_timeout_is_a_scored_invalid_case(self, urlopen):
        urlopen.side_effect = OSError("timed out")

        detected, valid, _latency_ms, error = classify_case(
            "http://127.0.0.1:11434/v1",
            "slow-model",
            {"text": "hello", "sensitive": False, "expected_values": []},
            0.01,
        )

        self.assertFalse(detected)
        self.assertFalse(valid)
        self.assertEqual(error, "OSError")


if __name__ == "__main__":
    unittest.main()
