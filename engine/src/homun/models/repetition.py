"""Conservative runaway-output guard for response repetition.

The line-diversity
check preserves distinct batch rows even when they share long exact prefixes.
"""
from collections import Counter
import math
import re

MIN_FRAGMENT_LENGTH = 400
# Hermes stop-path scale (agent/repetition_guard.py: real stop-path loops run
# 80k-350k chars, asked-for repeats stay in the low KB). Homun judges at 400
# in the normal turn; ONLY a turn whose user message asks for repetition
# (repetition_requested) moves the single criterion's floor here, and this
# value is a hard ceiling for that mode (never higher).
STOP_PATH_MIN_CHARS = 16_000
STREAM_TAIL_CHARS = 64_000
REPEAT_WINDOW = 60
MIN_REPEAT_COUNT = 5
DOMINANCE_RATIO = .5


class RepetitionError(ValueError):
    def __init__(self):
        super().__init__('Model output entered a repetition loop')


def is_runaway_repetition(text, *, min_chars=MIN_FRAGMENT_LENGTH):
    if not isinstance(text, str) or len(text) < min_chars:
        return False
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    if len(lines) >= MIN_REPEAT_COUNT and len(set(lines)) > len(lines) * .5:
        return False
    size = len(text)
    counts = Counter(lines)
    if any(count >= MIN_REPEAT_COUNT and count * len(line) >= size * DOMINANCE_RATIO
           for line, count in counts.items()):
        return True
    needed = max(MIN_REPEAT_COUNT, math.ceil(size * DOMINANCE_RATIO / REPEAT_WINDOW))
    windows = {}
    for offset in range(size - REPEAT_WINDOW + 1):
        key = text[offset:offset + REPEAT_WINDOW]
        count, previous = windows.get(key, (0, -REPEAT_WINDOW))
        if offset - previous < REPEAT_WINDOW:
            continue
        count += 1
        if count >= needed:
            return True
        windows[key] = (count, offset)
    return False


class RunawayStreamWatch:
    """Live repetition guard for streaming channels (content / reasoning).

    The live check and the end-of-turn check (``is_runaway_repetition`` in
    ``native_turn.parse_response``) apply ONE criterion at the TURN's floor:
    the first live evaluation runs at ``min_chars`` — the same floor the turn
    end uses (400 normally; STOP_PATH_MIN_CHARS in a turn that asked for
    repetition), so a reply the turn end would reject is cut as soon as the
    live cadence can prove it, and a reply the turn end would accept is never
    cut live. From Hermes b6aae42c3b comes the CADENCE, not the threshold:
    the next evaluation runs each time the channel doubles and only the
    bounded tail (``STREAM_TAIL_CHARS``) is judged, so total work stays
    linear in the output however long the reply grows.
    """

    def __init__(self, *, min_chars: int = MIN_FRAGMENT_LENGTH):
        self._min_chars = max(1, int(min_chars))
        self._chars = 0
        self._parts: list[str] = []
        self._next_check = self._min_chars

    def feed(self, chunk: str) -> bool:
        if not chunk:
            return False
        self._parts.append(chunk)
        self._chars += len(chunk)
        if self._chars < self._next_check:
            return False
        self._next_check = 2 * self._chars
        text = ''.join(self._parts)
        if len(text) > STREAM_TAIL_CHARS:
            text = text[-STREAM_TAIL_CHARS:]
        self._parts = [text]
        return is_runaway_repetition(text, min_chars=self._min_chars)


# ---------------------------------------------------------------------------
# Asked-repetition detection lives in asked_repetition.py (quote extraction →
# production verb → multiplicity signal → guards on the non-quoted text).
# Re-exported here so every import site keeps a single home for the
# repetition policy: the detectors, the floors, and the caps.
# ---------------------------------------------------------------------------
from homun.models.asked_repetition import (  # noqa: F401 — re-export
    MIN_ASKED_COPIES,
    RepetitionRequest,
    repetition_request,
    repetition_requested,
)


def turn_runaway_floor(user_message) -> int:
    """The single criterion's floor for a turn, decided from the ask alone."""
    return STOP_PATH_MIN_CHARS if repetition_requested(user_message) else MIN_FRAGMENT_LENGTH
