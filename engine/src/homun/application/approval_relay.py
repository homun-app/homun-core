"""Approval relay: gates reach the person on their own messaging channel.

A person binds their channel identity (WhatsApp/Telegram/…) with a pairing
code sent from that channel; from then on every approval gate owned by that
person is notified there with a one-time code, and an "A <code>" / "R <code>"
reply decides it. Approvals always flow through the canonical approve()
paths (digests, owner authority, journal) and are stamped
`_approval_channel: relay:<platform>` so human-relay decisions stay
distinguishable from policy auto-approvals and desktop clicks.
"""
from __future__ import annotations

import json
import logging
import secrets
import threading
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Optional

from homun.domain.errors import DomainError

logger = logging.getLogger(__name__)

STATE_FILENAME = "approval_relay.json"
CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # no I/1/O/0: typed on a phone
CODE_TTL_MINUTES = 15
ENROLL_PREFIX = "COLLEGA"
MAX_SEND_ATTEMPTS = 3

_lock = threading.Lock()
_state: Optional[Dict[str, Any]] = None
_state_path = None


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _expiry(minutes: int = CODE_TTL_MINUTES) -> str:
    return (_now() + timedelta(minutes=minutes)).isoformat()


def _expired(iso: str) -> bool:
    try:
        return datetime.fromisoformat(iso) <= _now()
    except (TypeError, ValueError):
        return True


def _load(ctx) -> Dict[str, Any]:
    global _state, _state_path
    path = ctx.data_dir / STATE_FILENAME
    if _state is None or _state_path != path:
        data: Dict[str, Any] = {"bindings": {}, "enroll": {}, "codes": {}, "gates": {}}
        try:
            data.update(json.loads(path.read_text(encoding="utf-8")))
        except FileNotFoundError:
            pass
        except Exception:
            logger.warning("approval relay state unreadable, starting fresh", exc_info=True)
        _state, _state_path = data, path
    return _state


def _save() -> None:
    if _state_path is None or _state is None:
        return
    tmp = _state_path.with_suffix(".tmp")
    tmp.write_text(json.dumps(_state, ensure_ascii=False, indent=1), encoding="utf-8")
    tmp.replace(_state_path)


def reset_for_tests() -> None:
    global _state, _state_path
    _state, _state_path = None, None


def _new_code() -> str:
    return "".join(secrets.choice(CODE_ALPHABET) for _ in range(6))


# ── bindings ─────────────────────────────────────────────────────────────────

def bindings(ctx) -> Dict[str, Dict[str, Any]]:
    with _lock:
        return dict(_load(ctx).get("bindings", {}))


def start_enroll(ctx, actor) -> Dict[str, Any]:
    """Generate a pairing code; the person sends it from their channel."""
    if getattr(actor, "kind", "person") != "person":
        raise DomainError("Only persons can bind an approval channel")
    with _lock:
        state = _load(ctx)
        code = _new_code()
        state["enroll"][code] = {"person_id": actor.id, "expires_at": _expiry()}
        _save()
    return {"code": code, "expires_in_minutes": CODE_TTL_MINUTES,
            "hint": f"Invia '{ENROLL_PREFIX} {code}' dal canale da collegare."}


def unbind(ctx, person_id: str) -> bool:
    with _lock:
        state = _load(ctx)
        removed = state["bindings"].pop(person_id, None) is not None
        _save()
    return removed


def _binding_for(state: Dict[str, Any], platform: str, user_id: str) -> Optional[str]:
    for person_id, binding in state["bindings"].items():
        if binding.get("platform") == platform and binding.get("user_id") == user_id:
            return str(person_id)
    return None


# ── gate discovery & notification ────────────────────────────────────────────

def _gate_label(kind: str, gate: Dict[str, Any], work_title: str) -> str:
    if kind == "run":
        return f"Esecuzione agente su «{work_title}»"
    if kind == "terminal":
        command = str(gate.get("command", ""))[:80]
        return f"Comando terminale su «{work_title}»: {command}"
    if kind == "edit":
        return f"Modifica file su «{work_title}»: {gate.get('path', '?')}"
    return f"«{work_title}»"


def _pending_gates(store) -> list[tuple[str, str, Dict[str, Any], str]]:
    """(kind, gate_id, gate, work_id) for every gate still awaiting a human."""
    from homun.application.agent_runs import PROPOSAL_TYPE
    gates: list[tuple[str, str, Dict[str, Any], str]] = []
    for record in store.commands.values():
        result = getattr(record, "result", None)
        if not isinstance(result, dict) or result.get("status") != "pending_approval":
            continue
        if record.type == PROPOSAL_TYPE and not result.get("_delegation_parent"):
            gates.append(("run", record.command_id, result, str(result.get("work_id", ""))))
        elif record.type == "terminal.job":
            gates.append(("terminal", record.command_id, result, str(result.get("work_id", ""))))
        elif record.type == "workspace.file_edit":
            gates.append(("edit", record.command_id, result, str(result.get("work_id", ""))))
    return gates


_registry_provider = None


def set_registry_provider(provider) -> None:
    """Wired by the routes layer at import time: keeps application free of routes."""
    global _registry_provider
    _registry_provider = provider


def _adapter_for(platform: str):
    if _registry_provider is None:
        return None
    try:
        return _registry_provider().get_adapter(platform)
    except Exception:
        return None


def pre_handler():
    """Claim closure for the inbound channel path (wired by the ingress routes)."""
    def _claim(message):
        try:
            from homun.context import get_context
            return handle_inbound(get_context(), message)
        except Exception:
            return None
    return _claim


def notify_pending(ctx) -> int:
    """Pump pass: notify every pending gate owned by a bound person. Idempotent."""
    from homun.application.channel_delivery_recovery import send_with_media_dispatch

    store = ctx.repository.load()
    notified = 0
    with _lock:
        state = _load(ctx)
        for kind, gate_id, gate, work_id in _pending_gates(store):
            if not work_id:
                continue
            work = store.works.get(work_id)
            if work is None or work.archived:
                continue
            person_id = work.owner_id or work.reviewer_id
            binding = state["bindings"].get(person_id)
            if not binding:
                continue
            tracked = state["gates"].setdefault(gate_id, {"attempts": 0, "notified": False})
            if tracked.get("notified") or int(tracked.get("attempts", 0)) >= MAX_SEND_ATTEMPTS:
                continue
            tracked["attempts"] = int(tracked.get("attempts", 0)) + 1
            code = _new_code()
            state["codes"][code] = {
                "kind": kind, "gate_id": gate_id, "work_id": work_id,
                "person_id": person_id, "expires_at": _expiry(),
            }
            _save()
        # snapshot what to send (sending happens outside the lock)
        to_send = [(code, entry) for code, entry in state["codes"].items()
                   if entry.get("expires_at") and not _expired(entry["expires_at"])
                   and not state["gates"].get(entry["gate_id"], {}).get("notified")]
    for code, entry in to_send:
        try:
            work = store.works.get(entry["work_id"])
            work_title = work.title if work else entry["work_id"]
            gate = store.commands.get(entry["gate_id"])
            gate_result = getattr(gate, "result", {}) if gate else {}
            label = _gate_label(entry["kind"], gate_result, work_title)
            adapter = _adapter_for(str(state["bindings"][entry["person_id"]]["platform"]))
            if adapter is None:
                raise DomainError("channel_unsupported")
            text = (f"🔐 Homun — autorizzazione richiesta\n"
                    f"{label}\n"
                    f"Rispondi: A {code} per approvare · R {code} per rifiutare\n"
                    f"(il codice scade tra {CODE_TTL_MINUTES} minuti)")
            result = send_with_media_dispatch(
                adapter, str(state["bindings"][entry["person_id"]]["target"]), text,
                intent_id=f"relay:{entry['gate_id']}")
            with _lock:
                state = _load(ctx)
                if result.get("delivered"):
                    state["gates"].setdefault(entry["gate_id"], {})["notified"] = True
                    notified += 1
                _save()
        except Exception:
            logger.warning("approval relay notify failed for %s", entry.get("gate_id"), exc_info=True)
    return notified


# ── inbound decisions ────────────────────────────────────────────────────────

def _approve_gate(ctx, entry: Dict[str, Any], channel: str) -> str:
    from homun.application import agent_runs, terminal_jobs, workspace_file_edits
    from homun.application.approval_auto import owner_actor
    from homun.domain.models import Actor

    store = ctx.repository.load()
    work = store.works.get(entry["work_id"])
    if work is None:
        return "❌ Lavoro non trovato."
    record = store.commands.get(entry["gate_id"])
    gate = getattr(record, "result", None) if record else None
    if not isinstance(gate, dict) or gate.get("status") != "pending_approval":
        return "❌ Il gate non è più in attesa (già deciso altrove?)."

    actor = Actor(id=entry["person_id"], workspace_id=ctx.workspace_id,
                  display_name="Approval relay", kind="person")
    if actor.id not in {work.owner_id, work.reviewer_id}:
        return "❌ Non hai autorità su questo lavoro."

    def _stamp() -> None:
        with ctx.repository.locked():
            with ctx.repository.transaction() as inner:
                rec = inner.commands.get(entry["gate_id"])
                if rec is not None:
                    rec.result["_approval_channel"] = f"relay:{channel}"
            ctx.service.store = inner

    try:
        if entry["kind"] == "run":
            agent_runs.approve(ctx, owner_actor(ctx, work), work.id, entry["gate_id"], {
                "command_id": f"relay:{entry['gate_id']}:{entry['gate_id'][-6:]}",
                "expected_version": gate["expected_version"], "digest": gate["digest"]})
        elif entry["kind"] == "terminal":
            terminal_jobs.approve(ctx, actor, work.id, entry["gate_id"], {"digest": gate["digest"]})
        elif entry["kind"] == "edit":
            workspace_file_edits.approve(ctx, actor, work.id, entry["gate_id"],
                                         {"digest": gate["digest"]})
        else:
            return "❌ Tipo di gate sconosciuto."
        _stamp()
        return "✅ Approvato da remoto. Il lavoro procede."
    except DomainError as exc:
        return f"❌ Approvazione rifiutata dal motore: {exc.message}"


def _reject_gate(ctx, entry: Dict[str, Any], channel: str = "relay") -> str:
    from homun.application import terminal_jobs
    from homun.domain.models import Actor

    store = ctx.repository.load()
    work = store.works.get(entry["work_id"])
    record = store.commands.get(entry["gate_id"])
    gate = getattr(record, "result", None) if record else None
    if work is None or not isinstance(gate, dict):
        return "❌ Gate non trovato."

    actor = Actor(id=entry["person_id"], workspace_id=ctx.workspace_id,
                  display_name="Approval relay", kind="person")
    try:
        if entry["kind"] == "run":
            # A pending run never started: cancel the proposal in place.
            with ctx.repository.locked():
                with ctx.repository.transaction() as inner:
                    rec = inner.commands.get(entry["gate_id"])
                    if rec is None or rec.result.get("status") != "pending_approval":
                        return "❌ Il gate non è più in attesa."
                    rec.result["status"] = "cancelled"
                    rec.result["_approval_channel"] = f"relay:{channel}:rejected"
                ctx.service.store = inner
            return "🛑 Run annullato."
        if entry["kind"] == "terminal":
            terminal_jobs.stop(ctx, actor, work.id, entry["gate_id"])
            return "🛑 Comando fermato."
        if entry["kind"] == "edit":
            with ctx.repository.locked():
                with ctx.repository.transaction() as inner:
                    rec = inner.commands.get(entry["gate_id"])
                    if rec is not None and rec.result.get("status") == "pending_approval":
                        rec.result["status"] = "rejected"
                        rec.result["rejected_by"] = actor.id
                ctx.service.store = inner
            return "🛑 Modifica file rifiutata."
        return "❌ Tipo di gate sconosciuto."
    except DomainError as exc:
        return f"❌ Rifiuto non riuscito: {exc.message}"


def handle_inbound(ctx, message) -> Optional[str]:
    """Pre-handler on the inbound channel path. None → normal conversation."""
    from homun.application.gateway_contracts import ChannelMessage
    if not isinstance(message, ChannelMessage):
        return None
    text = (message.text or "").strip().upper()
    if not text:
        return None
    parts = text.split()
    with _lock:
        state = _load(ctx)
        # pairing: COLLEGA <CODE>
        if len(parts) == 2 and parts[0] == ENROLL_PREFIX:
            entry = state["enroll"].get(parts[1])
            if entry is None or _expired(entry.get("expires_at", "")):
                return "❌ Codice di collegamento scaduto o sconosciuto."
            state["bindings"][entry["person_id"]] = {
                "platform": message.platform, "user_id": message.user_id,
                "target": message.channel_id, "bound_at": _now().isoformat()}
            state["enroll"].pop(parts[1], None)
            _save()
            return (f"🔗 Canale collegato: le autorizzazioni di {entry['person_id']} "
                    f"arriveranno qui.")
        # decision: A <CODE> / R <CODE>
        if len(parts) == 2 and parts[0] in {"A", "R"}:
            entry = state["codes"].get(parts[1])
            if entry is None:
                return "❌ Codice sconosciuto."
            if _expired(entry.get("expires_at", "")):
                state["codes"].pop(parts[1], None)
                _save()
                return "⌛ Codice scaduto: richiedi l'autorizzazione da desktop."
            bound_person = _binding_for(state, message.platform, message.user_id)
            if bound_person != entry["person_id"]:
                return "❌ Questo canale non è collegato alla persona del gate."
            state["codes"].pop(parts[1], None)
            _save()
    if len(parts) == 2 and parts[0] in {"A", "R"} and entry is not None:
        if parts[0] == "A":
            return _approve_gate(ctx, entry, message.platform)
        return _reject_gate(ctx, entry, message.platform)
    return None


def pending_codes(ctx) -> int:
    with _lock:
        state = _load(ctx)
        return sum(1 for entry in state.get("codes", {}).values()
                   if not _expired(entry.get("expires_at", "")))
