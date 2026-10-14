"""Does THIS TURN's user message ask the model to PRODUCE repeated copies?

Decided once per turn from the person's words, never from the generated
text. The detector is a pipeline, not one regex:

1. extract the quoted content ('…', "…", «…”, “…”, and the text after a
   request colon) — quoted content is DATA the model must produce, so the
   guards (negation, question, hypothesis) must never read it: «Scrivi
   'Non parlerò in classe' 100 volte» is a repetition ask;
2. split what remains into clauses;
3. a clause is a repetition ask when it carries BOTH a production verb
   directed at the assistant (scrivi/ripeti/copia/dimmi/stampa/genera/
   elenca — write/repeat/copy/say/print/output) AND a multiplicity signal:
   a copy count >= 3 («100 volte», «50 times», «100x», «3 copie», digits
   or word numbers) or «la stessa riga/frase» plus a row count
   («per 30 righe», «for 30 rows»);
4. guards apply to the NON-quoted clause text and kill a clause when they
   precede the verb or the signal: negation («non scrivere … 5 volte»),
   meta questions («perché ti ripeti?»), hypotheses («cosa succede se …?»),
   explainer asks («spiega come ripetere …»).

A count without a production verb is narration, not an ask («l'ho chiesto
3 volte»); «ripeti» without multiplicity means «say it again once». In
doubt: False — a false negative keeps today's behavior, a false positive
makes the loop guard 40x more permissive.
"""
from dataclasses import dataclass
import re

MIN_ASKED_COPIES = 3

# Word numbers >= MIN_ASKED_COPIES (Italian and English). Below-3 words
# ("due", "twice") are deliberately absent. Compound numbers ("venticinque",
# "twenty-five") are a documented false negative: in doubt, False.
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

# Multiplicity signals. Each carries the copy count explicitly.
_TIMES_COPIES_RE = re.compile(
    rf'\b(?P<num>{_NUM_TOKEN})\s*(?:volte|times|copie|copies)\b', re.I)
_TIMES_X_RE = re.compile(
    rf'(?:\bx\s*(?P<num>{_NUM_TOKEN})\b|\b(?P<num2>{_NUM_TOKEN})\s*x\b)', re.I)
_SAME_UNIT_RE = re.compile(r'\bstess[ao]\b|\bsame\b', re.I)
_ROWS_COUNT_RE = re.compile(
    rf'\b(?:per|for)?\s*(?P<num>{_NUM_TOKEN})\s+(?:righe|linee|rows|lines)\b', re.I)

# Production verbs in request position. Past participles ("scritto",
# "ripetuto", "copiato", "written", "repeated", "copied") and 3rd-person
# narration ("ripete", "repeats", "dice") are deliberately out: they narrate,
# they do not ask. Known accepted false positives: nouns that extend a stem
# ("scrivania", "stampante", "generale") followed by a count.
_SCRIV_RE = re.compile(
    r'\bscriv(?:i\w{0,5}|e(?:re|la|lo|le|mi|ci|vi|gli\w{0,4})|ete\w{0,4}|iamo|endo)\b', re.I)
_RIPET_RE = re.compile(
    r'\bripet(?:i\w{0,5}|e(?:re|la|lo|le|mi|ci|vi|gli\w{0,4})|ete\w{0,4}|iamo|endo)\b', re.I)
_COPI_RE = re.compile(
    r'\bcopi(?:a(?!(?:to|ta|ti)\b)\w{0,4}|re|te\w{0,4}|ndo)\b', re.I)
_STAMPA_RE = re.compile(
    r'\bstampa(?:(?!(?:to|ta|ti)\b)\w{0,4}|re|te\w{0,3}|ndo)\b', re.I)
_GENERA_RE = re.compile(
    r'\bgenera(?:(?!(?:to|ta|ti)\b)\w{0,4}|re|te\w{0,3}|ndo)\b', re.I)
_ELENCA_RE = re.compile(
    r'\belenca(?:(?!(?:to|ta|ti)\b)\w{0,4}|re|te\w{0,3}|ndo)\b', re.I)
_DI_RE = re.compile(
    r'\bdi(?:mmi|mme\w{0,4}|gli\w{0,4}|re|te\w{0,4}|ca\w{0,3}|ci\w{0,3}|ce\w{0,3})\b', re.I)
_EN_VERB_RE = re.compile(
    r'\b(?:write|writing|repeat|repeating|copy|copying|say|saying'
    r'|print|printing|output|outputting)\b', re.I)
_VERB_RES = (_SCRIV_RE, _RIPET_RE, _COPI_RE, _STAMPA_RE, _GENERA_RE,
             _ELENCA_RE, _DI_RE, _EN_VERB_RE)

# Guards read the NON-quoted clause text; a guard kills the clause when it
# PRECEDES the production verb or the multiplicity signal.
_NEGATION_RE = re.compile(
    r"\b(?:non|mai|senza|smetti\w*|evita\w*|niente|not|don'?t|never|stop|avoid)\b", re.I)
_QUESTION_ABOUT_RE = re.compile(
    r'\b(?:perch[ée]|why|cosa\s+significa|cosa\s+vuol\s+dire|what\s+do\s+you\s+mean'
    r'|what\s+does\b[^.!?]{0,40}\bmean)\b', re.I)
_HYPOTHETICAL_RE = re.compile(
    r'\b(?:cosa\s+succede\s+se|cosa\s+accade\s+se|cosa\s+succederebbe'
    r'|what\s+happens\s+if|what\s+if|e\s+se)\b', re.I)
_EXPLAINER_RE = re.compile(
    r'\b(?:spiega\w*|explain\w*|descrivi\w*|describe\w*)\b', re.I)
_GUARD_RES = (_NEGATION_RE, _QUESTION_ABOUT_RE, _HYPOTHETICAL_RE, _EXPLAINER_RE)

# A period between digits ("1.000") is a number, not a clause boundary.
_CLAUSE_SPLIT_RE = re.compile(r'(?<!\d)[.!?\n;]+(?!\d)')
_BRACKET_PAIRS = {'«': '»', '“': '”', '‘': '’'}
_STRAIGHT_QUOTES = '\'"'


@dataclass(frozen=True)
class RepetitionRequest:
    """The person asked for repeated copies; ``copies`` when explicit."""
    copies: int | None


def _count_value(token: str) -> int:
    token = token.lower()
    if token in _WORD_COUNTS:
        return _WORD_COUNTS[token]
    digits = re.sub(r'[.,]', '', token)
    return int(digits) if digits.isdigit() else 0


def _mask(text: str, start: int, end: int) -> str:
    """Blank a span, keeping every position stable."""
    return text[:start] + ' ' * (end - start) + text[end:]


def _extract_quoted_text(message: str) -> str:
    """Blank quoted spans: '…', "…", «…», “…”, ‘…’.

    Quoted content is what the model must produce, not part of the ask, so
    neither the signals nor the guards may read it. Bracket quotes pair
    unambiguously; a straight quote only OPENS when the previous character
    is not a letter, so Italian apostrophes («l'ho», «un po'») stay text.
    """
    text = message
    index = 0
    while index < len(text):
        char = text[index]
        closer = _BRACKET_PAIRS.get(char)
        if closer is None and char in _STRAIGHT_QUOTES \
                and not (index and text[index - 1].isalnum()):
            closer = char
        if closer is not None:
            end = text.find(closer, index + 1)
            if end > index + 1:
                text = _mask(text, index, end + 1)
                index = end + 1
                continue
        index += 1
    return text


def _strip_after_request_colon(text: str) -> str:
    """Blank the content that follows a request colon («Scrivi: ciao ciao»).

    Only when a production verb precedes the colon — that is the shape of
    an ask whose repeated content sits after the colon. Without a verb the
    colon is ordinary punctuation («te l'ho detto 100 volte: non toccarlo»).
    """
    colon = text.find(':')
    if colon == -1:
        return text
    head = text[:colon]
    if any(pattern.search(head) for pattern in _VERB_RES):
        return _mask(text, colon, len(text))
    return text


def _production_verb_start(clause: str) -> int | None:
    starts = [match.start() for pattern in _VERB_RES
              for match in pattern.finditer(clause)]
    return min(starts) if starts else None


def _signal_value(match: re.Match) -> int:
    token = match.group('num') or match.group('num2')
    return _count_value(token or '')


def _copies_signal(clause: str) -> tuple[int, int] | None:
    """(copy count, position) of the LAST qualifying multiplicity signal.

    The last match wins, so a self-correction («… 5 volte, anzi 100 volte»)
    keeps the final count. Row counts only count beside «la stessa
    riga/frase»: «elenca 30 righe» is a listing ask, not repetition.
    """
    signal = None
    for pattern in (_TIMES_COPIES_RE, _TIMES_X_RE):
        for match in pattern.finditer(clause):
            value = _signal_value(match)
            if value >= MIN_ASKED_COPIES:
                signal = (value, match.start())
    if _SAME_UNIT_RE.search(clause):
        for match in _ROWS_COUNT_RE.finditer(clause):
            value = _signal_value(match)
            if value >= MIN_ASKED_COPIES:
                signal = (value, match.start())
    return signal


def _killed_by_guard(clause: str, verb_start: int, signal_start: int) -> bool:
    lead = min(verb_start, signal_start)
    return any(match.start() < lead
               for pattern in _GUARD_RES for match in pattern.finditer(clause))


def repetition_request(user_message) -> RepetitionRequest | None:
    """The repetition ask of the message, with the explicit copy count."""
    if not isinstance(user_message, str) or not user_message.strip():
        return None
    text = _strip_after_request_colon(_extract_quoted_text(user_message))
    request = None
    for clause in _CLAUSE_SPLIT_RE.split(text):
        signal = _copies_signal(clause)
        if signal is None:
            continue
        copies, signal_start = signal
        verb_start = _production_verb_start(clause)
        if verb_start is None:
            continue
        if not _killed_by_guard(clause, verb_start, signal_start):
            request = RepetitionRequest(copies=copies)
    return request


def repetition_requested(user_message) -> bool:
    """Boolean shortcut for :func:`repetition_request`."""
    return repetition_request(user_message) is not None
