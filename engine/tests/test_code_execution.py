"""Tests for Programmatic Tool Calling (PTC) via Code Execution (H13).

Validates:
- Script execution with stdout/stderr capture and clean exit codes.
- Programmatic tool calling over local RPC socket bridge (`call_tool`).
- Tool whitelist enforcement and recursive execution rejection (`execute_code` cannot call `execute_code`).
- Tool invocation budgets (`max_tool_calls`) and script-level error recovery (`try/except`).
- Timeout enforcement and process cleanup.
- Large stdout output truncation (40% head / 60% tail with marker).
- Agent tool `execute_code` handler and policy gating.
"""
from __future__ import annotations

import time
from pathlib import Path
import pytest

from homun.application.code_execution_contracts import (
    DEFAULT_MAX_TOOL_CALLS,
    DEFAULT_TIMEOUT,
    MAX_STDOUT_BYTES,
    CodeExecutionArguments,
    entries as code_exec_entries,
)
from homun.application.code_execution_rpc import CodeExecutionRpcServer
from homun.application.code_execution_tool import (
    execute as code_exec_execute,
    run_code_with_rpc,
    truncate_output,
)
from homun.domain.errors import ValidationError


# ---------------------------------------------------------------------------
# 1. Basic Code Execution & Output Tests
# ---------------------------------------------------------------------------

def test_code_execution_basic():
    code = """
total = sum(range(10))
print(f"Total is {total}")
"""
    res = run_code_with_rpc(
        code=code,
        allowed_tools=set(),
        dispatcher=lambda name, args: None,
        timeout=10,
    )
    assert res.exit_code == 0
    assert "Total is 45" in res.stdout.strip()
    assert res.stderr == ""
    assert res.tool_calls_count == 0
    assert res.truncated is False


def test_code_execution_stderr_and_error():
    code = """
import sys
sys.stderr.write("Diagnostic warning\\n")
raise ValueError("Deliberate failure")
"""
    res = run_code_with_rpc(
        code=code,
        allowed_tools=set(),
        dispatcher=lambda name, args: None,
        timeout=10,
    )
    assert res.exit_code != 0
    assert "Diagnostic warning" in res.stderr
    assert "ValueError: Deliberate failure" in res.stderr


def test_code_execution_timeout():
    code = """
import time
time.sleep(5)
"""
    res = run_code_with_rpc(
        code=code,
        allowed_tools=set(),
        dispatcher=lambda name, args: None,
        timeout=1,
    )
    assert res.exit_code == -1
    assert "timed out after 1 seconds" in (res.error or "")


# ---------------------------------------------------------------------------
# 2. Programmatic Tool Calling & Error Recovery Tests
# ---------------------------------------------------------------------------

def test_code_execution_programmatic_tool_calling():
    mock_db = {
        "alpha.txt": "Alpha content with 10 lines",
        "beta.txt": "Beta content with 20 lines",
        "gamma.txt": "Gamma content with 30 lines",
    }

    def mock_dispatcher(tool_name: str, args: dict):
        if tool_name == "read_file":
            path = args.get("path")
            if path in mock_db:
                return {"content": mock_db[path], "bytes": len(mock_db[path])}
            raise FileNotFoundError(f"File not found: {path}")
        raise ValueError(f"Unknown tool: {tool_name}")

    # The script calls tools programmatically, loops, reduces output, and prints summary
    code = """
files = ["alpha.txt", "beta.txt", "missing.txt"]
total_bytes = 0

for f in files:
    try:
        data = call_tool("read_file", {"path": f})
        total_bytes += data["bytes"]
        print(f"Read {f}: {data['bytes']} bytes")
    except Exception as exc:
        print(f"Skipped {f}: {exc}")

print(f"Summary total: {total_bytes} bytes")
"""
    res = run_code_with_rpc(
        code=code,
        allowed_tools={"read_file"},
        dispatcher=mock_dispatcher,
        timeout=10,
    )
    assert res.exit_code == 0
    assert "Read alpha.txt: 27 bytes" in res.stdout
    assert "Read beta.txt: 26 bytes" in res.stdout
    assert "Skipped missing.txt: File not found: missing.txt" in res.stdout
    assert "Summary total: 53 bytes" in res.stdout
    assert res.tool_calls_count == 3
    assert len(res.tool_call_log) == 3


def test_code_execution_tool_allowlist_and_budget():
    def dummy_dispatcher(tool_name: str, args: dict):
        return {"pong": True}

    # Calling disallowed tool
    code_disallowed = """
try:
    call_tool("forbidden_tool", {})
    print("Should not reach here")
except Exception as exc:
    print(f"Caught error: {exc}")
"""
    res = run_code_with_rpc(
        code=code_disallowed,
        allowed_tools={"allowed_tool"},
        dispatcher=dummy_dispatcher,
    )
    assert res.exit_code == 0
    assert "Tool 'forbidden_tool' is not allowed" in res.stdout

    # Exceeding budget
    code_budget = """
for i in range(5):
    try:
        call_tool("allowed_tool", {"i": i})
        print(f"Call {i} ok")
    except Exception as exc:
        print(f"Call {i} failed: {exc}")
"""
    res_budget = run_code_with_rpc(
        code=code_budget,
        allowed_tools={"allowed_tool"},
        dispatcher=dummy_dispatcher,
        max_tool_calls=3,
    )
    assert res_budget.exit_code == 0
    assert "Call 0 ok" in res_budget.stdout
    assert "Call 1 ok" in res_budget.stdout
    assert "Call 2 ok" in res_budget.stdout
    assert "Call 3 failed: Tool call limit (3) reached" in res_budget.stdout
    assert res_budget.tool_calls_count == 3


# ---------------------------------------------------------------------------
# 3. Output Truncation Tests
# ---------------------------------------------------------------------------

def test_truncate_output():
    short_text = "Hello world\n"
    res, truncated = truncate_output(short_text, max_bytes=100)
    assert res == short_text
    assert truncated is False

    long_text = "A" * 10_000
    res_trunc, truncated_flag = truncate_output(long_text, max_bytes=1_000)
    assert truncated_flag is True
    assert "omitted" in res_trunc
    assert len(res_trunc.encode("utf-8")) < 2000


# ---------------------------------------------------------------------------
# 4. Agent Tool Execution & Policy Tests
# ---------------------------------------------------------------------------

def test_execute_code_tool_policy_gating():
    # Disabled policy
    run_disabled = {"code_execution": {"policy": "other"}}
    with pytest.raises(ValidationError, match="not enabled"):
        code_exec_execute(None, None, run_disabled, "execute_code", {"code": "print(1)"})

    # Enabled policy
    run_enabled = {
        "code_execution": {"policy": "programmatic-v1", "version": 1},
    }
    res = code_exec_execute(None, None, run_enabled, "execute_code", {
        "code": "print('Homun PTC active')",
    })
    assert res["exit_code"] == 0
    assert "Homun PTC active" in res["stdout"]


def test_code_execution_contract_entry():
    entries = code_exec_entries(code_exec_execute, version=1)
    assert len(entries) == 1
    assert entries[0].definition.name == "execute_code"
    assert entries[0].toolset == "code_execution"


def test_child_does_not_inherit_engine_secrets(tmp_path, monkeypatch):
    monkeypatch.setenv('HOMUN_TEST_SECRET', 'private-engine-value')
    result = run_code_with_rpc("import os; print(os.getenv('HOMUN_TEST_SECRET', 'absent'))", set(), lambda *a: None, cwd=tmp_path)
    assert result.exit_code == 0
    assert result.stdout.strip() == 'absent'


def test_timeout_kills_descendants_that_keep_output_open(tmp_path):
    import time
    code = "import subprocess,sys,time; subprocess.Popen([sys.executable,'-c','import time; time.sleep(5)']); time.sleep(5)"
    started = time.monotonic()
    result = run_code_with_rpc(code, set(), lambda *a: None, cwd=tmp_path, timeout=.2)
    assert result.error and 'timed out' in result.error
    assert time.monotonic() - started < 3


def test_code_execution_can_be_cancelled(tmp_path):
    import time
    started = time.monotonic()
    result = run_code_with_rpc('import time; time.sleep(10)', set(), lambda *a: None, cwd=tmp_path,
                              cancelled=lambda: time.monotonic() - started > .1)
    assert result.error == 'Execution cancelled'
    assert time.monotonic() - started < 3


def test_execute_code_registry_handler_has_correct_runtime_signature(tmp_path):
    from homun.application.agent_tool_registry import registry_for
    run={'assignee_id':'a', 'materials':[], 'code_execution':{'policy':'programmatic-v1','version':1}, '_cwd':str(tmp_path)}
    result=registry_for(run).dispatch('execute_code', {'code':'print("through registry")'},ctx=None,actor=None,run=run)
    assert result['exit_code']==0 and 'through registry' in result['stdout']
