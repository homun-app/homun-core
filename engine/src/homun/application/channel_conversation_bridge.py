"""Bridge authorized channel messages to supervised engine conversations.

Each channel chat maps to one engine conversation owned by a synthetic person
actor (``person_<platform>_<channel user id>``). The message runs through the
same ``admit``/``complete`` delivery the web app uses for
``conversation.post_message``, and the committed ``assistant_text`` goes back
to the channel registry for delivery. Typed failures surface their code to the
channel user instead of falling back to canned or simulated text.
"""
from __future__ import annotations

import json
import re
import time
import uuid
from pathlib import Path
from typing import Any, Dict

from homun.application.command_delivery import admit, complete
from homun.application.command_types import CommandRequest
from homun.application.gateway_contracts import ChannelMessage
from homun.domain.errors import CommandInProgressError, DomainError
from homun.domain.models import Actor

# Telegram rejects sendMessage bodies over 4096 characters; keep headroom
# for the truncation notice and delivery metadata.
REPLY_CHAR_LIMIT = 3800


class ChannelBridgeError(Exception):
    """Typed bridge failure; ``code`` is stable and shown to the channel user."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def _actor_for(workspace_id: str, message: ChannelMessage) -> Actor:
    platform = re.sub(r"[^a-z0-9_]", "", (message.platform or "channel").lower())
    who = re.sub(r"[^a-z0-9_]", "", (message.user_id or "anon").lower())
    who = who or "anon"
    display = message.username or message.user_id or "utente"
    return Actor(
        id=f"person_{platform}_{who}",
        workspace_id=workspace_id,
        display_name=f"{message.platform.capitalize()} · {display}",
        kind="person",
    )


def _binding_key(message: ChannelMessage) -> str:
    thread = message.thread_id or message.topic_id or "main"
    return f"{message.platform}:{message.channel_id}:{thread}"


def _bindings_path(data_dir: Path) -> Path:
    return data_dir / "channel_conversations.json"


def _load_bindings(data_dir: Path) -> Dict[str, str]:
    path = _bindings_path(data_dir)
    if not path.exists():
        return {}
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        return raw if isinstance(raw, dict) else {}
    except Exception:
        return {}


def _save_bindings(data_dir: Path, bindings: Dict[str, str]) -> None:
    path = _bindings_path(data_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(bindings, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def _conversation_for(ctx, actor: Actor, message: ChannelMessage) -> str:
    """Reuse the conversation bound to this chat, creating one on first contact."""
    key = _binding_key(message)
    bindings = _load_bindings(ctx.data_dir)
    existing = bindings.get(key)
    if existing:
        return existing
    command_id = f"chconv_{uuid.uuid4().hex[:12]}"
    # In-process commands commit under the repository transaction, exactly
    # like the cron runner: a bare service.apply would leave the conversation
    # invisible to the subsequent admit() reload.
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            service = ctx.service.for_store(store)
            result = service.apply(actor, command_id, "conversation.create",
                                   {"title": f"Canale {message.platform.capitalize()} · {actor.display_name.split('·')[-1].strip()}"})
        ctx.service.store = store
    conversation_id = result["conversation_id"]
    bindings[key] = conversation_id
    _save_bindings(ctx.data_dir, bindings)
    return conversation_id


def _clip(text: str) -> str:
    if len(text) <= REPLY_CHAR_LIMIT:
        return text
    return text[:REPLY_CHAR_LIMIT].rstrip() + "\n\n… (risposta troncata: continua nell'app Homun)"


def run_channel_turn(message: ChannelMessage) -> str:
    """One supervised conversation turn for an authorized channel message.

    Raises ChannelBridgeError with a stable code; callers decide how to
    surface the failure to the channel user.
    """
    from homun.context import get_context

    try:
        ctx = get_context()
    except Exception as exc:
        raise ChannelBridgeError("engine_context_unavailable", str(exc)) from exc

    actor = _actor_for(ctx.workspace_id, message)
    try:
        conversation_id = _conversation_for(ctx, actor, message)
    except DomainError as exc:
        raise ChannelBridgeError(exc.code, exc.message) from exc

    safe_id = re.sub(r"[^a-z0-9]", "", (message.id or uuid.uuid4().hex[:8]).lower())
    # Deterministic command id: Telegram redelivers updates, and replaying the
    # same command id returns the committed result instead of a second turn.
    body = CommandRequest(
        command_id=f"chmsg_{message.platform.lower()}_{safe_id}",
        type="conversation.post_message",
        payload={"conversation_id": conversation_id, "text": message.text},
    )
    try:
        delivery = admit(ctx, actor, body)
        result: Dict[str, Any] = complete(ctx, delivery)
    except CommandInProgressError as exc:
        raise ChannelBridgeError(
            "command_in_progress",
            "Un altro messaggio di questa conversazione è ancora in elaborazione.",
        ) from exc
    except DomainError as exc:
        raise ChannelBridgeError(exc.code, exc.message) from exc
    except RuntimeError as exc:  # ModelPort provider failures
        raise ChannelBridgeError("provider_unavailable", str(exc)) from exc

    text = str(result.get("assistant_text") or "")
    if result.get("agent_control") == "steer" and not text:
        text = "Messaggio inoltrato all'agente attivo."
    if result.get("plan_proposed") or result.get("plan_draft") or result.get("patch_proposal"):
        text = (text + "\n\nPuoi approvare o rivedere la proposta nell'app Homun.").strip()
    if not text.strip():
        raise ChannelBridgeError("empty_assistant_reply", "Il motore non ha prodotto una risposta.")
    return _clip(text)


def channel_reply(message: ChannelMessage) -> str:
    """Handler for ChannelRegistry.dispatch_inbound: turn or typed notice.

    Never echoes and never simulates: on failure the channel user gets the
    stable error code, and the inbound queue records the same text.
    """
    try:
        return run_channel_turn(message)
    except ChannelBridgeError as exc:
        return f"⚠️ Homun non ha potuto rispondere (codice: {exc.code}). Riprova tra poco."
