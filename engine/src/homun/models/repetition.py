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


def asked_copies_cap(copies: int) -> int:
    """Live and turn-end cut for an explicit copy count: the asked count
    with slack, ``max(copies * 1.5, copies + 10)``. Below it the asked
    repetition is delivered; one unit past it the reply is a loop (live
    observation: with «200 volte» the local model never stopped at 200)."""
    return max(math.ceil(copies * 1.5), copies + 10)


class RepetitionError(ValueError):
    def __init__(self):
        super().__init__('Model output entered a repetition loop')


def _unit_count_exceeds(text: str, cap: int) -> bool:
    """True when one non-empty line repeats more than ``cap`` times.

    The repeated unit is the LINE — the notion is_runaway_repetition already
    judges and the shape of an asked repetition («una per riga»); repetition
    with no newlines stays under the character criterion alone.
    """
    counts = Counter(line.strip() for line in text.splitlines() if line.strip())
    return any(count > cap for count in counts.values())


def is_runaway_repetition(text, *, min_chars=MIN_FRAGMENT_LENGTH, asked_copies=None):
    if not isinstance(text, str):
        return False
    # The asked-copies cap is a COUNT, not a char floor: a 300+ repeat of a
    # short unit stays under STOP_PATH_MIN_CHARS yet must be judged.
    if asked_copies is not None and _unit_count_exceeds(text, asked_copies_cap(asked_copies)):
        return True
    if len(text) < min_chars:
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

    With an explicit ``asked_copies`` the criterion also counts repeated
    units — the unit being the line — on EVERY completed line, independent
    of the char cadence, and cuts past ``asked_copies_cap(copies)``. The
    counter is incremental (O(total chars)) and counts the pending partial
    line too, so the live verdict equals the turn-end verdict at every
    stream length.
    """

    def __init__(self, *, min_chars: int = MIN_FRAGMENT_LENGTH, asked_copies=None):
        self._min_chars = max(1, int(min_chars))
        self._cap = None if not asked_copies else asked_copies_cap(int(asked_copies))
        self._unit_counts: Counter = Counter()
        self._unit_remainder = ''
        self._chars = 0
        self._parts: list[str] = []
        self._next_check = self._min_chars

    def feed(self, chunk: str) -> bool:
        if not chunk:
            return False
        self._parts.append(chunk)
        self._chars += len(chunk)
        if self._cap is not None and self._unit_cap_exceeded(chunk):
            return True
        if self._chars < self._next_check:
            return False
        self._next_check = 2 * self._chars
        text = ''.join(self._parts)
        if len(text) > STREAM_TAIL_CHARS:
            text = text[-STREAM_TAIL_CHARS:]
        self._parts = [text]
        return is_runaway_repetition(text, min_chars=self._min_chars, asked_copies=None)

    def _unit_cap_exceeded(self, chunk: str) -> bool:
        self._unit_remainder += chunk
        while '\n' in self._unit_remainder:
            line, _, self._unit_remainder = self._unit_remainder.partition('\n')
            line = line.strip()
            if line:
                self._unit_counts[line] += 1
                if self._unit_counts[line] > self._cap:
                    return True
        pending = self._unit_remainder.strip()
        return bool(pending) and self._unit_counts[pending] + 1 > self._cap


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
    return turn_runaway_policy(user_message)[0]


def turn_runaway_policy(user_message) -> tuple[int, int | None]:
    """(floor, asked copies) for a turn — one decision from the ask alone."""
    request = repetition_request(user_message)
    if request is None:
        return MIN_FRAGMENT_LENGTH, None
    return STOP_PATH_MIN_CHARS, request.copies
