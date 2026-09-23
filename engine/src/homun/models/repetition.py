"""Conservative runaway-output guard derived from Hermes agent/repetition_guard.py.

MIT copyright 2025 Nous Research; see notices/hermes-agent.txt. The line-diversity
check preserves distinct batch rows even when they share long exact prefixes.
"""
from collections import Counter
import math

MIN_FRAGMENT_LENGTH = 400
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
