"""Answer a bounded set of PTY status queries.

Derived from Hermes tools/pty_query_responder.py (MIT) at the pinned commit,
which ports openai/codex terminal query replies. See homun/notices/hermes-agent.txt.
This is not a screen emulator: cursor position is reported as home.
"""
from __future__ import annotations

_ESC = 0x1B
_MAX_MODE_DIGITS = 10
_MAX_QUERY_BYTES = _MAX_MODE_DIGITS + 5


class PtyQueryResponder:
    """Scan PTY output and return the bytes that should be written back once."""

    def __init__(self, rows: int = 24, cols: int = 80):
        self._query_responses = (
            (b"\x1b[5n", b"\x1b[0n"),
            (b"\x1b[18t", b"\x1b[8;%d;%dt" % (rows, cols)),
            (b"\x1b[6n", b"\x1b[1;1R"),
        )
        self._pending = bytearray()

    def process(self, data: bytes) -> tuple[bytes, bytes]:
        if not self._pending and _ESC not in data:
            return data, b""
        output = bytearray()
        responses = bytearray()
        pending = self._pending
        for byte in data:
            if not pending and byte != _ESC:
                output.append(byte)
                continue
            if byte == _ESC:
                output += pending
                pending.clear()
            pending.append(byte)
            if (len(pending) == 1 or bytes(pending) == b"\x1b["
                    or (pending[1] == ord("[") and not (0x40 <= byte <= 0x7E) and len(pending) < _MAX_QUERY_BYTES)):
                continue
            seq = bytes(pending)
            matched = False
            for query, response in self._query_responses:
                if seq == query:
                    responses += response
                    matched = True
                    break
            if not matched:
                mode = seq[3:-2]
                if (seq.startswith(b"\x1b[?") and seq.endswith(b"$p") and 0 < len(mode) <= _MAX_MODE_DIGITS
                        and mode.isdigit()):
                    responses += b"\x1b[?" + mode + b";0$y"
                else:
                    output += pending
            pending.clear()
        return bytes(output), bytes(responses)

    def flush(self) -> bytes:
        tail = bytes(self._pending)
        self._pending.clear()
        return tail


def unread(previous: str, current: str) -> str | None:
    """Return the new suffix. None means the log window moved and must not be answered again."""
    if not previous:
        return current
    if current.startswith(previous):
        return current[len(previous):]
    mark = previous[-200:]
    found = current.rfind(mark)
    if found < 0:
        return None
    return current[found + len(mark):]
