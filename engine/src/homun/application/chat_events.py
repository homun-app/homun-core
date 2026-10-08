"""Eventi SSE della conversazione: la chat in streaming a parti.

Ogni evento è una "parte" nel stile dei protocolli di stream moderni
(text-delta, tool-call, tool-result, message), così la UI può comporre
lo streaming, lo stato e le card tool senza conoscere i run.

Fonte dei dati: il record dei run chat (observations, _messages) e i
messaggi della conversazione, letti con polling breve sul repository —
la UI non fa polling: riceve un flusso.
"""
from __future__ import annotations

import asyncio
import json
import time
from typing import Any, Dict, Iterator, Optional

from homun.domain.errors import DomainError
from homun.models.finish_gates import THINK_BLOCK_RE, THINK_CONTENT_RE, strip_think_blocks
from homun.policy.work import require_conversation_access

POLL_SECONDS = 0.25
IDLE_TIMEOUT_SECONDS = 900.0
HEARTBEAT_SECONDS = 15.0


def _chat_runs_for(store, conversation_id: str):
    """I run chat di questa conversazione (marcati _chat_conversation_id)."""
    from homun.application.agent_runs import PROPOSAL_TYPE
    runs = []
    for record in store.commands.values():
        if record.type != PROPOSAL_TYPE or not isinstance(record.result, dict):
            continue
        run = record.result
        if run.get("_chat_conversation_id") == conversation_id:
            runs.append(run)
    return sorted(runs, key=lambda r: str(r.get("id")))


def _assistant_text(run: Dict[str, Any]) -> str:
    """Il testo visibile dell'ultimo messaggio assistente: il ragionamento
    (blocchi think, anche orfani) non si streamma in chat — come la risposta
    consegnata, che passa dagli stessi gate."""
    messages = run.get("_messages") or []
    for message in reversed(messages):
        if isinstance(message, dict) and message.get("role") == "assistant":
            return strip_think_blocks(str(message.get("content") or ""))
    return ""


def assistant_reasoning(run: Dict[str, Any]) -> str:
    """Il ragionamento dell'ultimo messaggio assistente, come testo: i blocchi
    think (chiusi o orfani) restano leggibili anche dopo la consegna, così la
    transcript li può mostrare collassati come in live."""
    messages = run.get("_messages") or []
    for message in reversed(messages):
        if isinstance(message, dict) and message.get("role") == "assistant":
            blocks = THINK_CONTENT_RE.findall(str(message.get("content") or ""))
            return "\n".join(block.strip() for block in blocks if block.strip())
    return ""


def _split_partial(text: str, run: Dict[str, Any]) -> tuple[str, str]:
    """Il parziale in-flight diviso in (ragionamento, visibile).

    Il tag di chiusura decide: prima di </think> è ragionamento, dopo è
    risposta. Finché il tag non arriva si usa la storia del run: se questo
    modello ha già chiuso pensieri con </think>, tutto il parziale è
    ragionamento (ChatGPT-style: pensa, poi risponde); altrimenti è già
    risposta che si streamma viva.
    """
    head, sep, tail = text.partition("</think>")
    if sep:
        reasoning = THINK_BLOCK_RE.sub("", head)
        return reasoning, tail
    uses_think = any(
        isinstance(m, dict) and m.get("role") == "assistant"
        and "</think>" in str(m.get("content") or "")
        for m in run.get("_messages") or [])
    if uses_think:
        return THINK_BLOCK_RE.sub("", text), ""
    stripped = text.lstrip()
    if stripped.startswith("<think>"):
        return stripped[len("<think>"):], ""
    return "", text


def _yield_stream_state(run_id: str, streamed: Dict[str, tuple], run: Dict[str, Any]):
    """Stato live del parziale in-flight (stream_partial del record): reasoning
    e testo completi, il client sostituisce — idempotente, niente delta."""
    partial = (run.get("stream_partial") or {}).get("text")
    if not isinstance(partial, str) or not partial:
        return []
    reasoning, visible = _split_partial(partial, run)
    current = (reasoning, visible)
    if streamed.get(f"state:{run_id}") == current:
        return []
    streamed[f"state:{run_id}"] = current
    return [_sse("stream_state", {"run_id": run_id,
                                  "reasoning": reasoning[-4000:],
                                  "text": visible})]


def _yield_text_delta(run_id: str, streamed: Dict[str, Any], text: str):
    """Delta d'accrescimento del testo visibile, con reset quando cambia
    il messaggio assistente di coda (turni con tool): il nuovo testo non
    estende il precedente, quindi si rimanda per intero con ``reset``."""
    key = f"text:{run_id}"
    previous = streamed.get(key, "")
    if text.startswith(previous) and len(text) > len(previous):
        streamed[key] = text
        return [_sse("text_delta", {"run_id": run_id, "delta": text[len(previous):]})]
    if not text.startswith(previous) and text != previous:
        streamed[key] = text
        return [_sse("text_delta", {"run_id": run_id, "delta": text, "reset": True})]
    return []


def conversation_events(ctx, actor, conversation_id: str,
                         *, max_idle_cycles: int | None = None) -> Iterator[str]:
    """Generatore SSE: parti della chat mentre il run lavora e risponde.

    ``max_idle_cycles`` chiude lo stream dopo N giri senza eventi (solo test);
    in produzione lo stream resta aperto fino all'idle timeout.
    """
    store = ctx.repository.load()
    conversation = require_conversation_access(store, actor, conversation_id, "read")

    seen_observations: Dict[str, set] = {}
    streamed: Dict[str, Any] = {}
    finished_runs: set = set()
    seen_messages: set = set()
    for message in store.messages.values():
        if message.conversation_id == conversation_id:
            seen_messages.add(message.id)
    last_event_at = time.monotonic()
    last_heartbeat = 0.0

    yield _sse("open", {"conversation_id": conversation.id,
                        "messages_already": len(seen_messages)})

    idle_cycles = 0
    while True:
        # scansione read-only: snapshot condiviso, reparsa solo a generation nuova
        store = ctx.repository.snapshot()
        now = time.monotonic()
        events_this_cycle = 0
        for run in _chat_runs_for(store, conversation_id):
            run_id = str(run.get("id"))
            seen = seen_observations.setdefault(run_id, set())
            if f"text:{run_id}" not in streamed:
                streamed[f"text:{run_id}"] = ""
                yield _sse("run_started", {"run_id": run_id,
                                           "status": run.get("status")})
                last_event_at = now
                events_this_cycle += 1
            for index, observation in enumerate(run.get("observations") or []):
                key = f"{index}:{observation.get('tool')}"
                if key in seen:
                    continue
                seen.add(key)
                last_event_at = now
                events_this_cycle += 1
                yield _sse("tool_result", {
                    "run_id": run_id, "tool": observation.get("tool"),
                    "message": str(observation.get("message") or "")[:400],
                    "result": _bounded(observation.get("result")),
                })
            # stato live del parziale in-flight: reasoning + testo che si scrivono
            if run.get("status") in {"running", "queued", "waiting_input",
                                     "waiting_external", "waiting_automation"}:
                live = _yield_stream_state(run_id, streamed, run)
                for chunk in live:
                    yield chunk
                if live:
                    last_event_at = now
                    events_this_cycle += len(live)
                deltas = _yield_text_delta(run_id, streamed, _assistant_text(run))
            elif run.get("status") in {"completed", "failed"} and run_id not in finished_runs:
                finished_runs.add(run_id)
                deltas = _yield_text_delta(run_id, streamed, _assistant_text(run))
                yield _sse("run_finished", {"run_id": run_id, "status": run.get("status")})
                last_event_at = now
                events_this_cycle += 1
            else:
                deltas = []
            for delta in deltas:
                yield delta
            if deltas:
                last_event_at = now
                events_this_cycle += len(deltas)

        for message in sorted(store.messages.values(), key=lambda m: m.created_at):
            if message.conversation_id != conversation_id or message.id in seen_messages:
                continue
            seen_messages.add(message.id)
            last_event_at = now
            events_this_cycle += 1
            yield _sse("message", {
                "message_id": message.id, "author_id": message.author_id,
                "text": message.text,
            })
        if now - last_heartbeat > HEARTBEAT_SECONDS:
            last_heartbeat = now
            yield ": keepalive\n\n"
        if max_idle_cycles is not None:
            if events_this_cycle:
                idle_cycles = 0
            else:
                idle_cycles += 1
                if idle_cycles >= max_idle_cycles:
                    yield _sse("closed", {"reason": "test-idle"})
                    return
        if now - last_event_at > IDLE_TIMEOUT_SECONDS:
            yield _sse("closed", {"reason": "idle"})
            return
        time.sleep(POLL_SECONDS)


def _bounded(value: Any, limit: int = 1200) -> Any:
    try:
        text = json.dumps(value, ensure_ascii=False, default=str)
        if len(text) <= limit:
            return value
        return {"truncated": text[:limit]}
    except Exception:
        return {"truncated": str(value)[:limit]}


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


def conversation_events_threaded(ctx, actor, conversation_id: str):
    """Ponte sync-over-async: il generatore gira in un thread dedicato."""
    import queue
    import threading

    output: "queue.Queue[Optional[str]]" = queue.Queue(maxsize=256)

    def produce() -> None:
        try:
            for chunk in conversation_events(ctx, actor, conversation_id):
                output.put(chunk)
        except Exception as exc:  # la caduta del produttore chiude lo stream
            output.put(_sse("error", {"message": str(exc)[:200]}))
        finally:
            output.put(None)

    threading.Thread(target=produce, daemon=True).start()

    def iterate() -> Iterator[str]:
        while True:
            chunk = output.get()
            if chunk is None:
                return
            yield chunk

    return iterate()
