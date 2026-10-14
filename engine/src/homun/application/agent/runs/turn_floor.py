"""The turn's runaway floor: decided once, from the person's message only.

One decision point for every model call of the turn (decide rounds, fallback
connections, MoA advisors/aggregator): ``floor_for_run`` reads the canonical
transcript, never the generated text, so the mode cannot flip mid-turn and a
durable replay decides exactly the same way.

Continuations (TruncatedTextError → CONTINUE_PROMPT) and engine nudges
('[SYSTEM]' rows) arrive as user-role messages but are NOT the person's ask:
they are skipped, so a continuation KEEPS the floor of the turn that asked.
Steering rows ARE the person's words and can raise the floor mid-turn.
Delegation children carry no person message at all: normal floor.
"""
import json

from homun.models.repetition import turn_runaway_floor
from homun.models.truncation import CONTINUE_PROMPT

_ENGINE_USER_PREFIX = '[SYSTEM]'


def _person_text(content: str) -> str:
    """The person's words inside a user row.

    Engine chat runs deliver the ask wrapped in the ``_objective`` JSON
    envelope (``runs.propose``): the detector must read the objective's
    unescaped text, not the envelope's quote characters.
    """
    stripped = content.strip()
    if stripped.startswith('{'):
        try:
            payload = json.loads(stripped)
        except ValueError:
            return content
        if isinstance(payload, dict) and 'available_materials' in payload \
                and isinstance(payload.get('objective'), str):
            return payload['objective'] or content
    return content


def user_message_for_floor(run) -> str | None:
    """The person's message this turn answers to, if any."""
    if run.get('_delegation_parent'):
        return None
    for message in reversed(run.get('_messages') or []):
        if not isinstance(message, dict) or message.get('role') != 'user':
            continue
        content = message.get('content')
        if not isinstance(content, str) or not content.strip():
            continue
        stripped = content.strip()
        if stripped == CONTINUE_PROMPT or stripped.startswith(_ENGINE_USER_PREFIX):
            continue
        return _person_text(content)
    return None


def floor_for_run(run) -> int:
    """400 normally; 16k only when the person asked for repetition."""
    return turn_runaway_floor(user_message_for_floor(run))
