"""Stable, versioned identity of a JSON command across transport and restarts."""
from __future__ import annotations

import hashlib
import json
from typing import Any

from homun.domain.errors import ValidationError
from homun.domain.models import Actor


def request_fingerprint(actor: Actor, command_type: str, payload: dict[str, Any]) -> str:
    try:
        canonical = json.dumps(
            {'workspace_id': actor.workspace_id, 'actor_id': actor.id,
             'actor_kind': actor.kind, 'type': command_type, 'payload': payload},
            sort_keys=True, separators=(',', ':'), ensure_ascii=True, allow_nan=False,
        )
    except (TypeError, ValueError) as exc:
        raise ValidationError('Command payload must contain finite JSON values') from exc
    return 'sha256:v1:' + hashlib.sha256(canonical.encode('utf-8')).hexdigest()
