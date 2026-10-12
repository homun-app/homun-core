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
# Asked-repetition detection: does THIS TURN's user message ask the model to
# produce multiple copies of the same content? Decided once per turn from the
# person's words, never from the generated text. Few clear signals, each
# guarded against the three ways a message cites repetition without asking
# for it: negation ("non ripetere", "don't write it 5 times"), meta questions
# ("why do you repeat yourself?"), hypotheticals ("cosa succede se … ?").
# ---------------------------------------------------------------------------

# Below a copy count of 3 the repetition cannot cross the normal fragment
# floor; counts of 2 ("due volte") are everyday narration and stay out.
MIN_ASKED_COPIES = 3

# Word numbers >= MIN_ASKED_COPIES (Italian and English). Below-3 words
# ("due", "twice") are deliberately absent.
_WORD_COUNTS = {
    'tre': 3, 'quattro': 4, 'cinque': 5, 'sei': 6, 'sette': 7, 'otto': 8,
    'nove': 9, 'dieci': 10, 'undici': 11, 'dodici': 12, 'tredici': 13,
    'quattordici': 14, 'quindici': 15, 'sedici': 16, 'diciassette': 17,
    'diciotto': 18, 'diciannove': 19, 'venti': 20, 'trenta': 30,
    'quaranta': 40, 'cinquanta': 50, 'sessanta': 60, 'settanta': 70,
    'ottanta': 80, 'novanta': 90, 'cento': 100, 'mille': 1000,
    'three': 3, 'four': 4, 'five': 5, 'six': 6, 'seven': 7, 'eight': 8,
    'nine': 9, 'ten': 10, 'eleven': 11, 'twelve': 12, 'thirteen': 13,
    'fourteen': 14, 'fifteen': 15, 'sixteen': 16, 'seventeen': 17,
    'eighteen': 18, 'nineteen': 19, 'twenty': 20, 'thirty': 30, 'forty': 40,
    'fifty': 50, 'sixty': 60, 'seventy': 70, 'eighty': 80, 'ninety': 90,
    'hundred': 100, 'thousand': 1000,
}
_NUM_TOKEN = r'\d+(?:[.,]\d{3})+|\d+|' + '|'.join(sorted(_WORD_COUNTS, key=len, reverse=True))
# "50 volte" / "50 times" / "cinquanta volte"
_TIMES_RE = re.compile(rf'\b({_NUM_TOKEN})\s*(?:volte|times)\b', re.I)
# "x50" / "100x"
_TIMES_X_RE = re.compile(rf'(?:\bx\s*({_NUM_TOKEN})\b|\b({_NUM_TOKEN})\s*x\b)', re.I)
# "30 righe uguali" / "twenty identical rows"
_IDENTICAL_ROWS_RE = re.compile(
    rf'\b({_NUM_TOKEN})\s+(?:righe|linee|rows|lines)\s+(?:uguali|identiche|same|identical)\b', re.I)
# Repetition verbs in request position (ripeti/ripetere/ripetetela…);
# "ripetizione", "ripetitivo" and past-participle narration deliberately
# do not match, nor does English "repeated"/"repetition".
_REPEAT_VERB_RE = re.compile(
    r'\bripet(?:i\w{0,3}|ere|ete\w{0,5}|iamo)\b|\brepeat(?:s|ing)?\b', re.I)
# A guard BEFORE a signal inside the same clause kills that signal.
_NEGATION_RE = re.compile(
    r"\b(?:non|mai|senza|smetti\w*|evita\w*|niente|not|don'?t|never|stop|avoid)\b", re.I)
_QUESTION_ABOUT_RE = re.compile(
    r'\b(?:perch[ée]|why|cosa\s+significa|cosa\s+vuol\s+dire|what\s+do\s+you\s+mean'
    r'|what\s+does\b[^.!?]{0,40}\bmean)\b', re.I)
_HYPOTHETICAL_RE = re.compile(
    r'\b(?:cosa\s+succede\s+se|cosa\s+accade\s+se|cosa\s+succederebbe'
    r'|what\s+happens\s+if|what\s+if|e\s+se)\b', re.I)
# A period between digits ("1.000") is a number, not a clause boundary.
_CLAUSE_SPLIT_RE = re.compile(r'(?<!\d)[.!?\n;]+(?!\d)')


def _count_value(token: str) -> int:
    token = token.lower()
    if token in _WORD_COUNTS:
        return _WORD_COUNTS[token]
    digits = re.sub(r'[.,]', '', token)
    return int(digits) if digits.isdigit() else 0


def _signal_positions(clause: str) -> list[int]:
    positions = []
    for match in _TIMES_RE.finditer(clause):
        if _count_value(match.group(1)) >= MIN_ASKED_COPIES:
            positions.append(match.start())
    for match in _TIMES_X_RE.finditer(clause):
        if _count_value(match.group(1) or match.group(2)) >= MIN_ASKED_COPIES:
            positions.append(match.start())
    positions.extend(match.start() for match in _IDENTICAL_ROWS_RE.finditer(clause))
    positions.extend(match.start() for match in _REPEAT_VERB_RE.finditer(clause))
    return positions


def repetition_requested(user_message) -> bool:
    """True when the message asks the model to produce multiple copies of the
    same content (explicit count, repetition verb, identical rows). Known
    cost, accepted: past-tense narration with a count ("te l'ho detto 100
    volte") also matches — it only raises the turn's floor to the 16k cap,
    so a real loop is still cut and rejected, just later.
    """
    if not isinstance(user_message, str) or not user_message.strip():
        return False
    for clause in _CLAUSE_SPLIT_RE.split(user_message):
        signals = _signal_positions(clause)
        if not signals:
            continue
        guards = [match.start()
                  for pattern in (_NEGATION_RE, _QUESTION_ABOUT_RE, _HYPOTHETICAL_RE)
                  for match in pattern.finditer(clause)]
        if any(all(guard >= signal for guard in guards) for signal in signals):
            return True
    return False


def turn_runaway_floor(user_message) -> int:
    """The single criterion's floor for a turn, decided from the ask alone."""
    return STOP_PATH_MIN_CHARS if repetition_requested(user_message) else MIN_FRAGMENT_LENGTH
