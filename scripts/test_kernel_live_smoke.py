import os
import unittest
from unittest.mock import patch

import scripts.kernel_live_smoke as smoke


class KernelLiveSmokeTests(unittest.TestCase):
    def test_default_prompt_requires_browser_and_stable_title(self):
        prompt = smoke.default_prompt()

        self.assertIn("usa il browser", prompt)
        self.assertIn("https://www.selenium.dev", prompt)
        self.assertIn("titolo", prompt)

    def test_gateway_token_prefers_desktop_token(self):
        with patch.dict(
            os.environ,
            {
                "HOMUN_DESKTOP_GATEWAY_TOKEN": "desktop-token",
                "HOMUN_EVAL_GATEWAY_TOKEN": "eval-token",
            },
            clear=True,
        ):
            self.assertEqual(smoke.gateway_token(), "desktop-token")

    def test_auth_headers_use_bearer_token(self):
        self.assertEqual(
            smoke.auth_headers("secret"),
            {
                "Authorization": "Bearer secret",
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
        )

    def test_latest_assistant_text_supports_flat_and_wrapped_payloads(self):
        flat = [
            {"role": "user", "content": "prompt"},
            {"role": "assistant", "content": "Il titolo della pagina e' Selenium."},
        ]
        wrapped = {"messages": flat}

        self.assertEqual(
            smoke.latest_assistant_text(flat),
            "Il titolo della pagina e' Selenium.",
        )
        self.assertEqual(
            smoke.latest_assistant_text(wrapped),
            "Il titolo della pagina e' Selenium.",
        )

    def test_answer_is_clean_requires_title_and_rejects_reasoning_markers(self):
        self.assertTrue(smoke.answer_is_clean("Il titolo della pagina e' Selenium."))
        self.assertFalse(smoke.answer_is_clean("<think>apro browser</think> Selenium"))
        self.assertFalse(smoke.answer_is_clean("REASONING: apro browser. Selenium"))


if __name__ == "__main__":
    os.chdir(os.path.dirname(os.path.dirname(__file__)))
    unittest.main()
