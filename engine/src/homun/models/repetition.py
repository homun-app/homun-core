"""Conservative runaway-output guard for response repetition.

The line-diversity
check preserves distinct batch rows even when they share long exact prefixes.
"""
from collections import Counter
import math

MIN_FRAGMENT_LENGTH = 400
# Hermes stop-path / first live-check floor (Homun stop path still uses MIN_FRAGMENT_LENGTH).
STOP_PATH_MIN_CHARS = 16_000
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

    Hermes b6aae42c3b: the stop-path criterion runs WHILE the channel streams.
    The first evaluation waits for ``min_chars`` — the stop-path floor
    (STOP_PATH_MIN_CHARS), because repetition the user asked for stays below it
    and must be delivered; the next runs each time the channel doubles, and
    only the bounded tail (STREAM_TAIL_CHARS) is judged, so total work stays
    linear in the output however long the reply grows.
    """

    def __init__(self, *, min_chars: int = STOP_PATH_MIN_CHARS):
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
