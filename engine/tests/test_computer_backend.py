"""Risoluzione del binario cua-driver: indipendente dalla posizione del modulo."""
import os
import sys
import sysconfig
from pathlib import Path

from homun.application.computer import backend


def _executable(path: Path) -> Path:
    path.write_text("#!/bin/sh\n")
    path.chmod(0o755)
    return path


def test_finds_driver_in_active_interpreter_scripts_dir(tmp_path, monkeypatch):
    driver = _executable(tmp_path / "cua-driver")
    monkeypatch.delenv("HOMUN_CUA_DRIVER_BIN", raising=False)
    monkeypatch.setattr(backend.sysconfig, "get_path", lambda name: str(tmp_path))
    monkeypatch.setattr(backend.shutil, "which", lambda name: None)
    assert backend.resolve_binary() == str(driver)


def test_explicit_env_override_wins(tmp_path, monkeypatch):
    explicit = _executable(tmp_path / "explicit-driver")
    scripts = tmp_path / "scripts"
    scripts.mkdir()
    _executable(scripts / "cua-driver")
    monkeypatch.setenv("HOMUN_CUA_DRIVER_BIN", str(explicit))
    monkeypatch.setattr(backend.sysconfig, "get_path", lambda name: str(scripts))
    assert backend.resolve_binary() == str(explicit)


def test_missing_everywhere_is_unavailable(tmp_path, monkeypatch):
    monkeypatch.delenv("HOMUN_CUA_DRIVER_BIN", raising=False)
    monkeypatch.setattr(backend.sysconfig, "get_path", lambda name: str(tmp_path))
    monkeypatch.setattr(backend.shutil, "which", lambda name: None)
    assert backend.resolve_binary() is None
    assert backend.available() is False


def test_scripts_dir_is_the_running_venv():
    # In dev the engine runs from engine/.venv: the candidate is its bin dir,
    # not engine/src/.venv as the old __file__-parents arithmetic produced.
    scripts = Path(sysconfig.get_path("scripts")).resolve()
    assert scripts.parent == Path(os.path.realpath(sys.prefix))
