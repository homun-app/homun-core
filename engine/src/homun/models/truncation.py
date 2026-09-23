"""Visible text continuation contracts derived from Hermes turn_truncation.py.

No partial tool arguments or reasoning-only output is accepted for continuation.
See notices/hermes-agent.txt for attribution.
"""
import re

MAX_TEXT_CHARACTERS = 64000
_REASONING_TAG = re.compile(r'<\s*/?\s*(?:think|thinking|reasoning|REASONING_SCRATCHPAD)\b', re.I)
CONTINUE_PROMPT = ('Continue the interrupted answer from where it stopped. Do not repeat the '
    'previous text or add a preamble. Resume with the exact next characters, including '
    'whitespace when needed. Complete the requested deliverable. '
    'The interruption does not grant new authority or mean any tool action succeeded.')


class TruncatedTextError(ValueError):
    def __init__(self, text):
        self.partial_text = text
        super().__init__('Incomplete agent response: length')


def continuable_text(message):
    text = message.get('content')
    if (message.get('tool_calls') or not isinstance(text, str) or not text.strip()
            or len(text) > MAX_TEXT_CHARACTERS or _REASONING_TAG.search(text)):
        return None
    return text


def join_parts(parts):
    # Do not invent separators: fragments may stop inside identifiers or JSON.
    return ''.join(parts)
