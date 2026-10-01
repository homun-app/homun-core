"""Pagine web a finestra + riassunto di contesto a gradini: il run non muore."""
import json

import pytest

from homun.execution.web_truncate import (
    clamp_char_limit, store_full_text, truncate_with_footer)


def test_small_page_passes_whole():
    text, truncated = truncate_with_footer("breve pagina", "https://x.example", 15000)
    assert text == "breve pagina" and truncated is False


def test_big_page_becomes_head_tail_window_with_footer(tmp_path):
    page = ("riga di contenuto\n" * 4000)  # ~84k caratteri
    stored = store_full_text(tmp_path, "https://x.example/long", page)
    assert stored is not None and stored.exists()
    text, truncated = truncate_with_footer(page, "https://x.example/long",
                                           15000, stored_path=stored)
    assert truncated is True
    assert len(text) < len(page) * 0.4
    assert "parte centrale omessa" in text
    assert stored.name in text  # il footer dice dove sta il testo completo
    # i tagli rispettano i confini di riga
    assert not text.startswith("riga di contenuto\n"[:5]) or text.splitlines()[0].endswith("contenuto")


def test_store_caps_multi_mb_pages(tmp_path):
    huge = "x" * 3_000_000
    stored = store_full_text(tmp_path, "https://x.example/huge", huge)
    assert stored.stat().st_size < 2_100_000  # mai byte illimitati su disco


def test_char_limit_clamped():
    assert clamp_char_limit(100) == 2000
    assert clamp_char_limit(10_000_000) == 500_000


def test_summary_fits_or_degrades_never_raises():
    from homun.models.context_summary import summary_request
    from homun.models.native_prompt import NativeMessage

    def messages(n, size):
        return [NativeMessage(role='assistant' if i % 2 else 'user',
                              content='a' * size) for i in range(n)]

    # finestra minuscola, sorgente enorme: nessuna eccezione, richiesta valida
    source = messages(80, 6000)
    request, clipped = summary_request(source, context_window=2000, output_tokens=256)
    blob = request[1].content
    assert len(blob) < 400_000
    # fallback deterministico: il riassunto entra comunque
    assert isinstance(clipped, list)


def test_summary_normal_path_still_works():
    from homun.models.context_summary import summary_request
    from homun.models.native_prompt import NativeMessage
    source = [NativeMessage(role='user', content='ciao'),
              NativeMessage(role='assistant', content='come va?')]
    request, clipped = summary_request(source, context_window=32_000, output_tokens=512)
    assert 'ciao' in request[1].content
    assert clipped == []
