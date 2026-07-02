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

    def test_select_scenarios_filters_by_id(self):
        selected = smoke.select_scenarios(smoke.build_scenarios(), ["S1", "S3"])

        self.assertEqual([scenario.id for scenario in selected], ["S1", "S3"])


if __name__ == "__main__":
    unittest.main()
