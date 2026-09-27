"""Real local subprocess protocol checks; never launch Codex or a provider."""
import json
import sys
import os

import pytest

from homun.application.codex_runtime import CodexAppServerAdapter

FIXTURE = r'''
import json, sys, time, os
mode, log = sys.argv[1:]
with open(log + ".pid", "w") as f: f.write(str(os.getpid()))
def send(x):
 print(json.dumps(x), flush=True)
def read(method=None):
 x=json.loads(sys.stdin.readline())
 with open(log, "a") as f: f.write(json.dumps(x)+"\n")
 if method: assert x.get("method")==method, x
 return x
def response(x, result): send({"jsonrpc":"2.0","id":x["id"],"result":result})
def note(method, **params):
 send({"jsonrpc":"2.0","method":method,"params":{"threadId":"th", "turnId":"tu", **params}})
x=read("initialize"); assert x["params"]["clientInfo"]["name"]=="homun-engine"; response(x,{})
read("initialized")
x=read("thread/start"); assert x["params"]["sandbox"]=="read-only"; response(x,{"thread": [] if mode=="bad_thread" else {} if mode=="missing_thread" else {"id":"th"}})
if mode in {"bad_thread", "missing_thread"}: time.sleep(10)
x=read("turn/start"); assert x["params"]["threadId"]=="th"; assert x["params"]["input"][0]["text"]=="hello"
note("item/agentMessage/delta",delta="early ")
response(x,{"turn": "bad" if mode=="bad_turn" else {"id":"tu"}})
if mode=="bad_turn": time.sleep(10)
if mode=="malformed":
 print("not json",flush=True); sys.exit()
if mode=="eof": sys.exit()
if mode=="bad_params":
 send({"jsonrpc":"2.0","method":"turn/completed","params":[]}); time.sleep(10)
if mode=="timeout": time.sleep(10)
if mode=="cancel":
 note("item/agentMessage/delta",delta="cancel")
 x=read("turn/interrupt"); assert x["params"]=={"threadId":"th","turnId":"tu"}; response(x,{})
 note("turn/completed",turn={"id":"tu","status":"interrupted"}); sys.exit()
note("item/agentMessage/delta",threadId="foreign",delta="WRONG")
note("turn/completed",turnId="foreign",turn={"id":"foreign","status":"completed"})
for id in ["a","b"]: note("item/started",item={"id":id,"type":"commandExecution","command":"same"})
for id in ["b","a"]: note("item/completed",item={"id":id,"type":"commandExecution","command":"same","aggregatedOutput":id,"exitCode":0})
send({"jsonrpc":"2.0","id":99,"method":"item/commandExecution/requestApproval","params":{"threadId":"th","turnId":"tu"}})
x=read(); assert x["id"]==99 and x["result"]=={"decision":"decline"}
note("item/agentMessage/delta",delta="done")
note("thread/tokenUsage/updated",tokenUsage={"last":{"totalTokens":17}})
note("turn/completed",turn={"id":"tu","status":"failed" if mode=="failed" else "completed","error":{"message":"provider failed"} if mode=="failed" else None})
'''


def adapter(tmp_path, mode="success"):
    script = tmp_path / "server.py"
    script.write_text(FIXTURE)
    log = tmp_path / "wire.jsonl"
    return CodexAppServerAdapter(sys.executable, [str(script), mode, str(log)]), log


def test_subprocess_handshake_projection_and_terminal_drain(tmp_path):
    client, log = adapter(tmp_path)
    result = client.run_turn([{"role":"user", "content":"hello"}], cwd=str(tmp_path))
    assert result.status == "completed"
    assert result.text == "early done"
    assert result.tokens_used == 17
    assert [(t["id"], t["result"]) for t in result.tool_calls] == [("a","a"),("b","b")]
    wire = [json.loads(line) for line in log.read_text().splitlines()]
    assert sum(x.get("method")=="turn/start" for x in wire) == 1
    assert result.source == "engine"
    with pytest.raises(ProcessLookupError):
        os.kill(int((tmp_path / "wire.jsonl.pid").read_text()), 0)


@pytest.mark.parametrize("mode,code", [("eof","runtime_protocol_error"),("malformed","runtime_protocol_error"),("timeout","runtime_timeout"),("failed","runtime_failed")])
def test_failures_do_not_promote_partial_text_or_retry(tmp_path, mode, code):
    client, log = adapter(tmp_path, mode)
    result = client.run_turn([{"role":"user", "content":"hello"}], cwd=str(tmp_path), timeout_seconds=0.4)
    assert result.status == "failed"
    assert result.error_code == code
    assert result.text == ("early done" if mode == "failed" else "early ")
    assert log.read_text().count('"method": "turn/start"') == 1


def test_missing_binary_is_typed_unavailable():
    client = CodexAppServerAdapter("/definitely/missing/homun-codex")
    result = client.run_turn([{"role":"user", "content":"hello"}])
    assert result.status == "unavailable"
    assert result.error_code == "backend_unavailable"
    assert result.text == ""


def test_empty_replay_never_spawns():
    result = CodexAppServerAdapter("/missing").run_turn([], event_feed=[])
    assert result.source == "simulation"
    assert result.text == ""


def test_interrupt_is_sent_and_process_cleaned(tmp_path):
    client, log = adapter(tmp_path,"cancel")
    result = client.run_turn([{"role":"user", "content":"hello"}], cwd=str(tmp_path), on_text_delta=lambda delta: client.interrupt() if delta=="cancel" else None)
    assert result.status == "interrupted"
    assert result.interrupted
    assert '"method": "turn/interrupt"' in log.read_text()


@pytest.mark.parametrize("mode", ["bad_thread", "missing_thread", "bad_turn", "bad_params"])
def test_invalid_protocol_shapes_are_typed_and_process_reaped(tmp_path, mode):
    client, log = adapter(tmp_path, mode)
    result = client.run_turn([{"role": "user", "content": "hello"}], timeout_seconds=0.5)
    assert result.status == "failed"
    assert result.error_code == "runtime_protocol_error"
    with pytest.raises(ProcessLookupError):
        os.kill(int((tmp_path / "wire.jsonl.pid").read_text()), 0)


def test_completed_message_is_authoritative_over_commentary():
    result = CodexAppServerAdapter('/missing').run_turn([], event_feed=[
        {'method':'item/agentMessage/delta','params':{'delta':'Working...'}},
        {'method':'item/completed','params':{'item':{'type':'agentMessage','id':'final','text':'Actual final answer'}}},
    ])
    assert result.text == 'Actual final answer'


def test_cancel_during_initialize_is_bounded(tmp_path):
    import threading, time
    script = tmp_path / 'stall.py'
    script.write_text('import time; time.sleep(20)')
    client = CodexAppServerAdapter(sys.executable, [str(script)])
    timer = threading.Timer(.1, client.interrupt)
    timer.start()
    started = time.monotonic()
    try:
        result = client.run_turn([], timeout_seconds=10)
    finally:
        timer.cancel()
    assert time.monotonic() - started < 3
    assert result.status == 'interrupted'


def test_stalled_stdin_write_respects_deadline(tmp_path):
    import time
    script = tmp_path / 'no-read.py'
    script.write_text('''import json,sys,time
for method in ['initialize','initialized','thread/start']:
 x=json.loads(sys.stdin.readline())
 if method!='initialized': print(json.dumps({'id':x['id'],'result':{'thread':{'id':'th'}} if method=='thread/start' else {}}),flush=True)
time.sleep(15)
''')
    client=CodexAppServerAdapter(sys.executable,[str(script)])
    started=time.monotonic()
    result=client.run_turn([{'role':'user','content':'x'*2_000_000}],timeout_seconds=.3)
    assert time.monotonic()-started < 3
    assert result.error_code=='runtime_timeout'
