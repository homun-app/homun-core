import json
import tempfile
import unittest
from pathlib import Path

import scripts.smoke_kernel_projection as smoke


def projection(**overrides):
    payload = {
        "thread_id": "thread-test",
        "revision": 1,
        "turn": {
            "active_turn_id": None,
            "status": "completed",
            "last_event_seq": 3,
            "terminal_reason": "done",
            "failure_text": None,
            "updated_at": 1,
        },
        "plan": None,
        "activity": [],
        "subagents": [],
        "browser": {
            "state": "idle",
            "target_id": None,
            "latest_progress": None,
            "failure_reason": None,
            "snapshot_verified": False,
        },
        "capability_runtime": {
            "loaded_tools": [],
            "armed_sensitive_domains": [],
            "pending_capability": None,
            "blocked_capabilities": [],
        },
        "attention": {
            "awaiting_user": False,
            "approvals": [],
            "uncertain_effects": [],
        },
        "actions": {
            "can_stop": False,
            "composer_mode": "new_turn",
        },
    }
    payload.update(overrides)
    return payload


class SmokeKernelProjectionTests(unittest.TestCase):
    def test_default_fixtures_cover_required_kernel_cases(self):
        ok, detail = smoke.run_smoke(smoke.DEFAULT_FIXTURE_DIR)

        self.assertTrue(ok, detail)
        self.assertIn("validated", detail)

    def test_fixture_validation_checks_endpoint_and_expectations(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "broken.json"
            path.write_text(
                json.dumps(
                    {
                        "case": "terminal_liveness_after_reload",
                        "endpoint": "/api/chat/threads/thread-test/messages",
                        "response": projection(),
                        "expect": {
                            "equals": {
                                "turn.status": "running",
                            }
                        },
                    }
                ),
                encoding="utf-8",
            )

            failures = smoke.validate_fixture(path)

        self.assertIn("endpoint: expected persisted /kernel-projection path", failures)
        self.assertIn("turn.status: expected 'running', got 'completed'", failures)

    def test_smoke_fails_when_required_cases_are_missing(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "only-terminal.json"
            path.write_text(
                json.dumps(
                    {
                        "case": "terminal_liveness_after_reload",
                        "endpoint": "/api/chat/threads/thread-test/kernel-projection",
                        "response": projection(),
                        "expect": {
                            "equals": {
                                "turn.status": "completed",
                                "actions.composer_mode": "new_turn",
                            }
                        },
                    }
                ),
                encoding="utf-8",
            )

            ok, detail = smoke.run_smoke(Path(directory))

        self.assertFalse(ok)
        self.assertIn("missing required cases", detail)


if __name__ == "__main__":
    unittest.main()
