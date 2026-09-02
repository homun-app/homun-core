import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import scripts.clean_runtime_smoke as clean


class CleanRuntimeSmokeTests(unittest.TestCase):
    def test_builds_smoke_command_for_isolated_gateway_and_selected_scenarios(self):
        args = clean.parse_args(["--profile", "all", "--scenario", "S1", "--scenario", "X5"])

        command = clean.build_smoke_args(args, "http://127.0.0.1:19999")

        self.assertEqual(
            command,
            [
                clean.PYTHON,
                "scripts/production_smoke.py",
                "--profile",
                "all",
                "--gateway-base",
                "http://127.0.0.1:19999",
                "--scenario",
                "S1",
                "--scenario",
                "X5",
            ],
        )

    def test_audit_command_targets_same_clean_data_dir(self):
        command = clean.build_audit_args(Path("/tmp/homun-clean"), 7)

        self.assertEqual(
            command,
            [
                clean.PYTHON,
                "scripts/audit_homun_state.py",
                "--data-dir",
                "/tmp/homun-clean",
                "--max-findings-per-code",
                "0",
                "--max-timeline-events",
                "7",
            ],
        )

    def test_main_sets_clean_profile_env_for_gateway_smoke_and_audit(self):
        calls = []

        class FakeProcess:
            stdout = None
            stderr = None

            def poll(self):
                return 0

        def fake_start_gateway(binary, data_dir, port, token):
            calls.append(("gateway", os.fspath(data_dir), port, token))
            return FakeProcess()

        def fake_run_command(args, env, name):
            calls.append((name, args, env["HOMUN_DATA_DIR"], env["HOMUN_EVAL_GATEWAY_TOKEN"]))
            return clean.CommandResult(name, 0, f"{name} ok\n", "", list(args))

        with tempfile.TemporaryDirectory() as tmp:
            with mock.patch.object(clean, "start_gateway", side_effect=fake_start_gateway), mock.patch.object(
                clean, "wait_for_gateway"
            ), mock.patch.object(clean, "stop_gateway", return_value=("", "")), mock.patch.object(
                clean, "run_command", side_effect=fake_run_command
            ), mock.patch.object(
                clean, "find_free_port", return_value=19998
            ):
                code = clean.main(["--data-dir", tmp, "--profile", "baseline", "--scenario", "S1"])

        self.assertEqual(code, 0)
        self.assertEqual(calls[0][0], "gateway")
        self.assertEqual(os.path.realpath(calls[0][1]), os.path.realpath(tmp))
        self.assertEqual(calls[0][2], 19998)
        smoke = calls[1]
        audit = calls[2]
        self.assertEqual(smoke[0], "production_smoke")
        self.assertEqual(audit[0], "audit_homun_state")
        self.assertEqual(os.path.realpath(smoke[2]), os.path.realpath(tmp))
        self.assertEqual(os.path.realpath(audit[2]), os.path.realpath(tmp))
        self.assertEqual(smoke[3], calls[0][3])
        self.assertEqual(audit[3], calls[0][3])

    def test_main_passes_short_model_timeouts_to_smoke_and_audit_env(self):
        captured_env = {}

        class FakeProcess:
            stdout = None
            stderr = None

            def poll(self):
                return 0

        def fake_run_command(args, env, name):
            captured_env[name] = dict(env)
            return clean.CommandResult(name, 0, "", "", list(args))

        with tempfile.TemporaryDirectory() as tmp:
            with mock.patch.object(clean, "start_gateway", return_value=FakeProcess()), mock.patch.object(
                clean, "wait_for_gateway"
            ), mock.patch.object(clean, "stop_gateway", return_value=("", "")), mock.patch.object(
                clean, "run_command", side_effect=fake_run_command
            ), mock.patch.object(
                clean, "find_free_port", return_value=19996
            ):
                code = clean.main(
                    [
                        "--data-dir",
                        tmp,
                        "--model-headers-timeout-secs",
                        "3",
                        "--model-first-token-timeout-secs",
                        "4",
                        "--model-idle-timeout-secs",
                        "5",
                    ]
                )

        self.assertEqual(code, 0)
        for env in captured_env.values():
            self.assertEqual(env["HOMUN_MODEL_HEADERS_TIMEOUT_SECS"], "3")
            self.assertEqual(env["HOMUN_MODEL_FIRST_TOKEN_SECS"], "4")
            self.assertEqual(env["HOMUN_MODEL_IDLE_TIMEOUT_SECS"], "5")

    def test_main_can_boot_and_audit_without_running_smoke(self):
        names = []

        class FakeProcess:
            stdout = None
            stderr = None

            def poll(self):
                return 0

        def fake_run_command(args, env, name):
            names.append(name)
            return clean.CommandResult(name, 0, "", "", list(args))

        with tempfile.TemporaryDirectory() as tmp:
            with mock.patch.object(clean, "start_gateway", return_value=FakeProcess()), mock.patch.object(
                clean, "wait_for_gateway"
            ), mock.patch.object(clean, "stop_gateway", return_value=("", "")), mock.patch.object(
                clean, "run_command", side_effect=fake_run_command
            ), mock.patch.object(
                clean, "find_free_port", return_value=19997
            ):
                code = clean.main(["--data-dir", tmp, "--skip-smoke"])

        self.assertEqual(code, 0)
        self.assertEqual(names, ["audit_homun_state"])

    def test_seed_config_copies_selected_non_db_files_without_secrets_by_default(self):
        with tempfile.TemporaryDirectory() as source, tempfile.TemporaryDirectory() as target:
            source_path = Path(source)
            target_path = Path(target)
            (source_path / "providers.json").write_text("{}", encoding="utf-8")
            (source_path / "runtime-settings.json").write_text("{}", encoding="utf-8")
            (source_path / "secrets.json").write_text("secret", encoding="utf-8")
            (source_path / "homun.sqlite").write_text("db", encoding="utf-8")

            copied = clean.seed_config(source_path, target_path)

            self.assertEqual(copied, ["providers.json", "runtime-settings.json"])
            self.assertTrue((target_path / "providers.json").is_file())
            self.assertTrue((target_path / "runtime-settings.json").is_file())
            self.assertFalse((target_path / "secrets.json").exists())
            self.assertFalse((target_path / "homun.sqlite").exists())

    def test_seed_config_copies_secrets_only_when_requested(self):
        with tempfile.TemporaryDirectory() as source, tempfile.TemporaryDirectory() as target:
            source_path = Path(source)
            target_path = Path(target)
            (source_path / "providers.json").write_text("{}", encoding="utf-8")
            (source_path / "secret-key").write_bytes(b"x" * 32)
            (source_path / "secrets.json").write_text("secret", encoding="utf-8")

            copied = clean.seed_config(source_path, target_path, include_secrets=True)

            self.assertEqual(copied, ["providers.json", "secret-key", "secrets.json"])
            self.assertTrue((target_path / "secret-key").is_file())
            self.assertTrue((target_path / "secrets.json").is_file())


if __name__ == "__main__":
    unittest.main()
