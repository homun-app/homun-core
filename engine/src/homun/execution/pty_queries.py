"""Answer a bounded set of PTY status queries and maintain virtual terminal screen state.

Ports openai/codex terminal query replies. Can be connected to VirtualTerminalScreen
for real cursor position reporting, or defaults to home cursor.
"""
from __future__ import annotations

import codecs
from typing import Any, Callable, Optional
import re

_ESC = 0x1B
_MAX_MODE_DIGITS = 10
_MAX_QUERY_BYTES = _MAX_MODE_DIGITS + 5


class PtyQueryResponder:
    """Scan PTY output and return the bytes that should be written back once."""

    def __init__(
        self,
        rows: int = 24,
        cols: int = 80,
        cursor_fn: Optional[Callable[[], tuple[int, int]]] = None,
        feed_fn: Optional[Callable[[bytes | str], None]] = None,
    ):
        self.rows = rows
        self.cols = cols
        self.cursor_fn = cursor_fn
        self.feed_fn = feed_fn
        self._pending = bytearray()

    def process(self, data: bytes) -> tuple[bytes, bytes]:
        if not self._pending and _ESC not in data:
            if self.feed_fn is not None:
                self.feed_fn(data)
            return data, b""
        output = bytearray()
        responses = bytearray()
        pending = self._pending

        def _emit(b: bytes | bytearray) -> None:
            if b:
                output.extend(b)
                if self.feed_fn is not None:
                    self.feed_fn(bytes(b))

        for byte in data:
            if not pending and byte != _ESC:
                _emit(bytes([byte]))
                continue
            if byte == _ESC:
                _emit(pending)
                pending.clear()
            pending.append(byte)
            if (len(pending) == 1 or bytes(pending) == b"\x1b["
                    or (pending[1] == ord("[") and not (0x40 <= byte <= 0x7E) and len(pending) < _MAX_QUERY_BYTES)):
                continue
            seq = bytes(pending)
            matched = False
            if seq == b"\x1b[5n":
                responses += b"\x1b[0n"
                matched = True
            elif seq == b"\x1b[18t":
                responses += b"\x1b[8;%d;%dt" % (self.rows, self.cols)
                matched = True
            elif seq == b"\x1b[6n":
                if self.cursor_fn is not None:
                    row, col = self.cursor_fn()
                    responses += b"\x1b[%d;%dR" % (row + 1, col + 1)
                else:
                    responses += b"\x1b[1;1R"
                matched = True

            if not matched:
                mode = seq[3:-2]
                if (seq.startswith(b"\x1b[?") and seq.endswith(b"$p") and 0 < len(mode) <= _MAX_MODE_DIGITS
                        and mode.isdigit()):
                    responses += b"\x1b[?" + mode + b";0$y"
                else:
                    _emit(pending)
            pending.clear()
        return bytes(output), bytes(responses)

    def flush(self) -> bytes:
        tail = bytes(self._pending)
        self._pending.clear()
        if tail and self.feed_fn is not None:
            self.feed_fn(tail)
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


class VirtualTerminalScreen:
    """In-memory 2D character matrix virtual terminal screen emulator.

    Interprets raw ANSI escape sequences, carriage returns, cursor movements,
    clears, and overwrites to maintain a rendered 2D terminal visual state.
    Preserves fragmented escape sequences and incomplete UTF-8 bytes across feeds.
    """

    def __init__(self, rows: int = 24, cols: int = 80) -> None:
        self.rows = max(1, rows)
        self.cols = max(1, cols)
        self.cursor_row = 0
        self.cursor_col = 0
        self.grid = [[" " for _ in range(self.cols)] for _ in range(self.rows)]
        self._pending_escape: str = ""
        self._utf8_decoder = codecs.getincrementaldecoder("utf-8")("replace")
        self._pending_bytes: bytearray = bytearray()

    def _scroll_up(self) -> None:
        self.grid.pop(0)
        self.grid.append([" " for _ in range(self.cols)])
        self.cursor_row = self.rows - 1

    def feed(self, text_or_bytes: str | bytes) -> None:
        """Feed raw output stream with ANSI escape sequences into the screen matrix."""
        if isinstance(text_or_bytes, bytes):
            text = self._utf8_decoder.decode(text_or_bytes, final=False)
            self._pending_bytes = bytearray(self._utf8_decoder.getstate()[0])
        else:
            text = str(text_or_bytes)

        if self._pending_escape:
            text = self._pending_escape + text
            self._pending_escape = ""

        i = 0
        n = len(text)
        while i < n:
            ch = text[i]

            if ch == "\r":
                self.cursor_col = 0
                i += 1
                continue
            if ch == "\n":
                if self.cursor_row >= self.rows - 1:
                    self._scroll_up()
                else:
                    self.cursor_row += 1
                i += 1
                continue
            if ch == "\b":
                self.cursor_col = max(0, self.cursor_col - 1)
                i += 1
                continue
            if ch == "\t":
                tab_stop = (self.cursor_col // 8 + 1) * 8
                self.cursor_col = min(self.cols - 1, tab_stop)
                i += 1
                continue

            # ANSI escape sequence
            if ch == "\x1b":
                if i + 1 >= n:
                    self._pending_escape = "\x1b"
                    break
                if text[i + 1] == "[":
                    tail = text[i:]
                    match = re.match(r"\x1b\[([0-9;]*)([A-Za-z])", tail)
                    if match:
                        full_seq = match.group(0)
                        params = match.group(1)
                        cmd = match.group(2)
                        i += len(full_seq)

                        parts = [int(p) for p in params.split(";") if p.isdigit()]

                        if cmd in ("H", "f"):  # Cursor Position (CUP)
                            r = (parts[0] - 1) if parts else 0
                            c = (parts[1] - 1) if len(parts) > 1 else 0
                            self.cursor_row = max(0, min(self.rows - 1, r))
                            self.cursor_col = max(0, min(self.cols - 1, c))
                        elif cmd == "A":  # Cursor Up
                            delta = parts[0] if parts else 1
                            self.cursor_row = max(0, self.cursor_row - delta)
                        elif cmd == "B":  # Cursor Down
                            delta = parts[0] if parts else 1
                            self.cursor_row = min(self.rows - 1, self.cursor_row + delta)
                        elif cmd == "C":  # Cursor Forward
                            delta = parts[0] if parts else 1
                            self.cursor_col = min(self.cols - 1, self.cursor_col + delta)
                        elif cmd == "D":  # Cursor Back
                            delta = parts[0] if parts else 1
                            self.cursor_col = max(0, self.cursor_col - delta)
                        elif cmd == "J":  # Erase in Display (ED)
                            mode = parts[0] if parts else 0
                            if mode == 2:  # Clear entire screen
                                self.grid = [[" " for _ in range(self.cols)] for _ in range(self.rows)]
                                self.cursor_row = 0
                                self.cursor_col = 0
                            elif mode == 0:  # Clear from cursor to end
                                for col in range(self.cursor_col, self.cols):
                                    self.grid[self.cursor_row][col] = " "
                                for row in range(self.cursor_row + 1, self.rows):
                                    self.grid[row] = [" " for _ in range(self.cols)]
                        elif cmd == "K":  # Erase in Line (EL)
                            mode = parts[0] if parts else 0
                            if mode == 0:  # Clear from cursor to end
                                for col in range(self.cursor_col, self.cols):
                                    self.grid[self.cursor_row][col] = " "
                            elif mode == 1:  # Clear from start to cursor
                                for col in range(0, min(self.cols, self.cursor_col + 1)):
                                    self.grid[self.cursor_row][col] = " "
                            elif mode == 2:  # Clear entire line
                                self.grid[self.cursor_row] = [" " for _ in range(self.cols)]
                        continue
                    else:
                        # Check if partial escape sequence at the end of chunk
                        if re.match(r"^\x1b\[[0-9;?]*$", tail):
                            self._pending_escape = tail
                            break
                        # Unrecognized complete escape, advance past escape
                        i += 2
                        continue

            # Printable char
            if ord(ch) >= 32:
                if self.cursor_col < self.cols and self.cursor_row < self.rows:
                    self.grid[self.cursor_row][self.cursor_col] = ch
                    self.cursor_col += 1
                    if self.cursor_col >= self.cols:
                        self.cursor_col = 0
                        if self.cursor_row >= self.rows - 1:
                            self._scroll_up()
                        else:
                            self.cursor_row += 1

            i += 1

    def render_screen(self, trim_trailing: bool = True) -> str:
        """Render the 2D matrix into a string representation."""
        lines = []
        for row in self.grid:
            line = "".join(row)
            if trim_trailing:
                line = line.rstrip()
            lines.append(line)
        result = "\n".join(lines)
        return result.rstrip() if trim_trailing else result

    def cursor_position(self) -> tuple[int, int]:
        return (self.cursor_row, self.cursor_col)

    def dump_state(self) -> dict[str, Any]:
        """Serialize complete emulator state for durable persistence."""
        return {
            "rows": self.rows,
            "cols": self.cols,
            "cursor_row": self.cursor_row,
            "cursor_col": self.cursor_col,
            "grid": [list(row) for row in self.grid],
            "pending_escape": self._pending_escape,
            "pending_bytes": bytes(self._pending_bytes).hex(),
        }

    def load_state(self, state: dict[str, Any]) -> None:
        """Restore emulator state from serialized dictionary."""
        self.rows = state.get("rows", self.rows)
        self.cols = state.get("cols", self.cols)
        self.cursor_row = state.get("cursor_row", 0)
        self.cursor_col = state.get("cursor_col", 0)
        grid_data = state.get("grid")
        if isinstance(grid_data, list) and len(grid_data) == self.rows:
            self.grid = [list(r)[:self.cols] for r in grid_data]
        self._pending_escape = state.get("pending_escape", "")
        raw_pending = bytes.fromhex(state.get("pending_bytes") or "")
        self._utf8_decoder = codecs.getincrementaldecoder("utf-8")("replace")
        if raw_pending:
            self._utf8_decoder.setstate((raw_pending, 0))
        self._pending_bytes = bytearray(raw_pending)
