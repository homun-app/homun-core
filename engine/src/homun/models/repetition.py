"""Conservative runaway-output guard for response repetition.

The line-diversity
check preserves distinct batch rows even when they share long exact prefixes.
"""
from collections import Counter
import math

MIN_FRAGMENT_LENGTH = 400
STREAM_TAIL_CHARS = 64_000
REPEAT_WINDOW = 60
MIN_REPEAT_COUNT = 5
DOMINANCE_RATIO = .5


class RepetitionError(ValueError):
    def __init__(self):
        super().__init__('Model output entered a repetition loop')


def is_runaway_repetition(text):
    if not isinstance(text, str) or len(text) < MIN_FRAGMENT_LENGTH:
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
    ``native_turn.parse_response``) apply ONE criterion: the first live
    evaluation runs at the same ``MIN_FRAGMENT_LENGTH`` floor the turn end
    uses, so a reply the turn end would reject is cut as soon as the live
    cadence can prove it, and a reply the turn end would accept is never
    cut live. From Hermes b6aae42c3b comes the CADENCE, not the threshold:
    the next evaluation runs each time the channel doubles and only the
    bounded tail (``STREAM_TAIL_CHARS``) is judged, so total work stays
    linear in the output however long the reply grows. Hermes's 16k
    stop-path floor was deliberately not ported — the Homun stop path
    judges at 400 to stop local-model loops early.
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
        return is_runaway_repetition(text)
