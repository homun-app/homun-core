"""Side-channel trace persistence for Mixture of Agents runs (H24).

Appends JSONL records to `<homun_traces>/moa-traces/<session_id>.jsonl` when enabled.
Side-channel only: never enters the database messages table or corrupts chat history.
"""
from __future__ import annotations

import json
import logging
import os
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)


def _sanitize_session_id(session_id: Optional[str]) -> str:
    if not session_id:
        return "unknown_session"
    return "".join(c if (c.isalnum() or c in "-_.") else "_" for c in str(session_id))


def save_moa_turn_trace(
    *,
    session_id: Optional[str],
    preset_name: str,
    advisors: List[Dict[str, Any]],
    aggregator: Dict[str, Any],
    trace_dir: Optional[str] = None,
    save_traces: bool = True,
) -> None:
    """Append one full MoA turn trace to session jsonl if enabled."""
    if not save_traces:
        return

    try:
        if trace_dir:
            base_dir = Path(os.path.expandvars(os.path.expanduser(trace_dir)))
        else:
            homun_home = os.environ.get("HOMUN_HOME") or os.path.expanduser("~/.homun")
            base_dir = Path(homun_home) / "moa-traces"

        base_dir.mkdir(parents=True, exist_ok=True)
        safe_id = _sanitize_session_id(session_id)
        trace_file = base_dir / f"{safe_id}.jsonl"

        record = {
            "ts": time.time(),
            "session_id": session_id,
            "preset": preset_name,
            "advisors": advisors,
            "aggregator": aggregator,
        }

        with trace_file.open("a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False, default=str) + "\n")
    except Exception as exc:
        logger.debug("MoA trace recording failed for session %s: %s", session_id, exc)
