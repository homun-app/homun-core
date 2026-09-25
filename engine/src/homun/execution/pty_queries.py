"""Answer a bounded set of PTY status queries.

which ports openai/codex terminal query replies.
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


class VirtualTerminalScreen:
    """In-memory 2D character matrix virtual terminal screen emulator.

    Interprets raw ANSI escape sequences, carriage returns, cursor movements,
    clears, and overwrites to maintain a rendered 2D terminal visual state.
    """

    def __init__(self, rows: int = 24, cols: int = 80) -> None:
        self.rows = max(1, rows)
        self.cols = max(1, cols)
        self.cursor_row = 0
        self.cursor_col = 0
        self.grid = [[" " for _ in range(self.cols)] for _ in range(self.rows)]

    def _scroll_up(self) -> None:
        self.grid.pop(0)
        self.grid.append([" " for _ in range(self.cols)])
        self.cursor_row = self.rows - 1

    def feed(self, text_or_bytes: str | bytes) -> None:
        """Feed raw output stream with ANSI escape sequences into the screen matrix."""
        if isinstance(text_or_bytes, bytes):
            text = text_or_bytes.decode("utf-8", errors="replace")
        else:
            text = str(text_or_bytes)

        import re

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
            if ch == "\x1b" and i + 1 < n and text[i + 1] == "[":
                match = re.match(r"\x1b\[([0-9;]*)([A-Za-z])", text[i:])
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

                # Unrecognized or partial escape, advance past escape
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

