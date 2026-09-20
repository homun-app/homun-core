"""Architecture checks must reject concrete dependency and growth regressions."""
import importlib.util
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]


def checker():
    spec = importlib.util.spec_from_file_location("architecture_check", ROOT / "tools/check_architecture.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def write(root, path, content):
    target = root / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content)


def test_domain_rejects_infrastructure_import(tmp_path):
    write(tmp_path, "engine/src/homun/domain/rules.py", "from homun.storage.sqlite import SqliteWorkspaceRepository\n")
    result = checker().check(tmp_path, {})
    assert any("forbidden import" in error for error in result[0])


@pytest.mark.parametrize("source", ["from ..routes import commands\n", "import fastapi\n", "from homun import context\n"])
def test_domain_rejects_relative_and_external_imports(tmp_path, source):
    write(tmp_path, "engine/src/homun/domain/rules.py", source)
    assert checker().check(tmp_path, {})[0]


def test_import_cycle_detected(tmp_path):
    write(tmp_path, "engine/src/homun/a.py", "from homun.b import value\n")
    write(tmp_path, "engine/src/homun/b.py", "from .a import other\n")
    assert any("import cycle" in error for error in checker().check(tmp_path, {})[0])


def test_oversized_new_file_rejected(tmp_path):
    write(tmp_path, "apps/web/src/new.ts", "// line\n" * 801)
    assert any("800" in error for error in checker().check(tmp_path, {})[0])


def test_review_threshold_reported(tmp_path):
    write(tmp_path, "apps/web/src/new.ts", "// line\n" * 501)
    errors, reports = checker().check(tmp_path, {})
    assert not errors
    assert any("501" in report for report in reports)


def test_legacy_growth_rejected(tmp_path):
    path = "apps/web/src/legacy.ts"
    write(tmp_path, path, "// line\n" * 901)
    assert any("legacy growth" in error for error in checker().check(tmp_path, {"line_budgets": {path: 900}})[0])


def test_exception_is_exact_and_stale_exception_must_be_removed(tmp_path):
    path = "engine/src/homun/domain/commands/execution.py"
    write(tmp_path, path, "from homun.runtime import bridge\n")
    baseline = {"import_exceptions": [{"source": "homun.domain.commands.execution", "target": "homun.runtime.bridge", "reason": "Pending outbox"}]}
    assert not checker().check(tmp_path, baseline)[0]
    write(tmp_path, path, "from homun.runtime import dbos_app\n")
    errors, _ = checker().check(tmp_path, baseline)
    assert any("forbidden import" in error for error in errors)
    assert any("stale import exception" in error for error in errors)


def test_repository_architecture():
    import json
    baseline = json.loads((ROOT / "tools/architecture-baseline.json").read_text())
    errors, _ = checker().check(ROOT, baseline)
    assert errors == [], "\n".join(errors)


def test_type_checking_import_does_not_create_runtime_cycle(tmp_path):
    write(tmp_path, "engine/src/homun/a.py", "from homun.b import value\n")
    write(tmp_path, "engine/src/homun/b.py", "from typing import TYPE_CHECKING\nif TYPE_CHECKING:\n    from homun.a import value\n")
    assert not checker().check(tmp_path, {})[0]


def test_route_cannot_import_sqlite_directly(tmp_path):
    write(tmp_path, "engine/src/homun/routes/commands.py", "import sqlite3\n")
    assert any("forbidden import" in error for error in checker().check(tmp_path, {})[0])


def test_reduced_legacy_file_requires_smaller_budget(tmp_path):
    path = "apps/web/src/legacy.ts"
    write(tmp_path, path, "// line\n" * 850)
    errors, _ = checker().check(tmp_path, {"line_budgets": {path: 900}})
    assert any("Shrink legacy budget" in error for error in errors)


def test_deleted_legacy_file_requires_removing_budget(tmp_path):
    errors, _ = checker().check(tmp_path, {"line_budgets": {"apps/web/src/legacy.ts": 900}})
    assert any("stale legacy budget" in error for error in errors)


def test_domain_package_init_cannot_import_infrastructure(tmp_path):
    write(tmp_path, "engine/src/homun/domain/__init__.py", "import sqlite3\n")
    assert any("forbidden import" in error for error in checker().check(tmp_path, {})[0])
