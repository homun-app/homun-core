"""Bounded PTY query replies. The live subprocess case is covered by the Docker proof."""
from homun.execution.pty_queries import PtyQueryResponder, unread


def test_plain_output_passes_through():
    out, resp = PtyQueryResponder().process(b"hello world\n")
    assert out == b"hello world\n" and resp == b""


def test_device_status_report_answered_and_stripped():
    out, resp = PtyQueryResponder().process(b"before\x1b[5nafter")
    assert out == b"beforeafter" and resp == b"\x1b[0n"


def test_window_size_and_cursor_reports():
    out, resp = PtyQueryResponder(rows=30, cols=120).process(b"\x1b[18t")
    assert out == b"" and resp == b"\x1b[8;30;120t"
    out, resp = PtyQueryResponder().process(b"\x1b[6n")
    assert out == b"" and resp == b"\x1b[1;1R"


def test_queries_split_across_chunks_and_unhandled_color_passes():
    responder = PtyQueryResponder()
    out1, resp1 = responder.process(b"before\x1b[")
    out2, resp2 = responder.process(b"5n\x1b[18t\x1b[6n\x1b[?1049$p\x1b[31mafter")
    assert resp1 + resp2 == b"\x1b[0n\x1b[8;24;80t\x1b[1;1R\x1b[?1049;0$y"
    assert out1 + out2 + responder.flush() == b"before\x1b[31mafter"


def test_aborted_partial_and_oversized_mode_pass_through():
    responder = PtyQueryResponder()
    out, resp = responder.process(b"\x1b[6\x1b[5n")
    assert out == b"\x1b[6" and resp == b"\x1b[0n"
    seq = b"\x1b[?12345678901$p"
    responder = PtyQueryResponder()
    out, resp = responder.process(seq)
    assert resp == b"" and out + responder.flush() == seq


def test_unread_suffix_does_not_replay_a_shifted_window():
    assert unread("", "alpha") == "alpha"
    assert unread("alpha", "alphabet") == "bet"
    assert unread("alphabet", "bet") is None


def test_virtual_terminal_screen_ansi_matrix():
    from homun.execution.pty_queries import VirtualTerminalScreen

    term = VirtualTerminalScreen(rows=5, cols=20)
    term.feed("Hello World!\r\nLine 2")
    screen = term.render_screen()
    assert "Hello World!" in screen
    assert "Line 2" in screen
    assert term.cursor_position() == (1, 6)

    # Test carriage return overwrite
    term.feed("\rOverwritten")
    lines = term.render_screen().splitlines()
    assert lines[1] == "Overwritten"

    # Test cursor positioning and line clear
    term.feed("\x1b[1;1H\x1b[2KTop Line")
    lines = term.render_screen().splitlines()
    assert lines[0] == "Top Line"

    # Test clear screen
    term.feed("\x1b[2JNew Clean")
    screen = term.render_screen()
    assert screen == "New Clean"

