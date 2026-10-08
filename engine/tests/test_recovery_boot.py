"""Recovery mode: un workspace corrotto non ferma mai l'avvio del motore.

I tre casi: righe che non validano più (quello successo davvero: un evento
senza sequence/aggregate_version uccideva il boot), pagine danneggiate,
file del tutto illeggibile. Più la esposizione in health e la diagnosi in chat.
"""
from __future__ import annotations

import sqlite3

import pytest

from homun.context import create_context, create_context_with_recovery
from homun.domain.models import Actor
from homun.storage.recovery import clear_report, db_state, last_report


@pytest.fixture
def ctx(tmp_path):
    ctx = create_context(db_path=tmp_path / 'engine.db', data_dir=tmp_path, for_tests=True)
    yield ctx
    ctx.close()


def _seed(ctx, count=3):
    actor = Actor(id='person_owner', workspace_id=ctx.workspace_id, display_name='Owner')
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            for index in range(count):
                ctx.service.for_store(store).apply(
                    actor, f'c{index}', 'conversation.create', {'title': f'Conv {index}'})


def _raw(db_path):
    return sqlite3.connect(db_path)


def test_invalid_event_row_is_quarantined_and_engine_boots(ctx, tmp_path):
    """Il caso realmente capitato: payload evento invalido → prima il boot moriva."""
    _seed(ctx)
    db_path = ctx.repository.path
    ctx.close()
    conn = _raw(db_path)
    conn.execute("INSERT INTO events (sequence, payload) VALUES (99999, '{\"foo\": 1}')")
    conn.commit()
    conn.close()
    with pytest.raises(Exception):
        create_context(db_path=db_path, data_dir=tmp_path, for_tests=True)

    recovered = create_context_with_recovery(db_path=db_path, data_dir=tmp_path,
                                             for_tests=True)
    try:
        report = last_report(tmp_path)
        assert report is not None
        assert report['mode'] == 'repaired'
        assert any(issue['kind'] == 'row_invalid' and issue['table'] == 'events'
                   for issue in report['issues'])
        # le conversazioni buone sopravvivono
        store = recovered.repository.load()
        assert sum(1 for c in store.conversations.values() if c.title.startswith('Conv')) == 3
        state = db_state(tmp_path)
        assert state['state'] == 'repaired'
    finally:
        recovered.close()


def test_garbage_file_boots_minimal(tmp_path):
    db_path = tmp_path / 'engine.db'
    db_path.write_bytes(b'this is not a database' * 100)
    ctx = create_context_with_recovery(db_path=db_path, data_dir=tmp_path,
                                       for_tests=True)
    try:
        report = last_report(tmp_path)
        assert report is not None
        assert report['mode'] == 'minimal'
        assert db_state(tmp_path)['state'] == 'minimal'
        # il workspace parte vuoto ma coerente
        store = ctx.repository.load()
        assert store.workspace_id == ctx.workspace_id
    finally:
        ctx.close()


def test_corrupt_pages_boot_with_recovery(ctx, tmp_path):
    """Pagine danneggiate al centro del file: quarantena e ricostruzione."""
    _seed(ctx, count=40)
    db_path = ctx.repository.path
    ctx.close()
    size = db_path.stat().st_size
    data = bytearray(db_path.read_bytes())
    # corrompo blocchi nella zona dati (mai l'header della prima pagina)
    for start in (max(4096, size // 3), max(4096, size // 2)):
        data[start:start + 2048] = b'\xde\xad\xbe\xef' * 512
    db_path.write_bytes(bytes(data))

    # la corruzione deve essere effettiva: se le pagine colpite erano libere
    # l'avvio pulito è legittimo e il recovery non ha nulla da fare
    # (su Linux quick_check può lanciare DatabaseError invece di restituirla)
    try:
        conn = sqlite3.connect(db_path)
        check = conn.execute('PRAGMA quick_check').fetchone()[0]
        conn.close()
    except sqlite3.DatabaseError:
        check = 'database disk image is malformed'

    recovered = create_context_with_recovery(db_path=db_path, data_dir=tmp_path,
                                             for_tests=True)
    try:
        state = db_state(tmp_path)
        if check == 'ok':
            assert state['state'] == 'ok'
        else:
            assert state['state'] in {'repaired', 'minimal'}
            if state['state'] == 'repaired':
                store = recovered.repository.load()
                if len(store.conversations) == 0:
                    # la perdita deve essere dichiarata dal rapporto, non muta
                    entities = state['report']['tables'].get('entities', {})
                    assert entities.get('lost', 0) > 0 or any(
                        issue['kind'] in ('page_corruption', 'unreadable_table')
                        for issue in state['report']['issues'])
        # il database attivo è integro in ogni caso
        conn = sqlite3.connect(db_path)
        assert conn.execute('PRAGMA quick_check').fetchone()[0] == 'ok'
        conn.close()
    finally:
        recovered.close()


def test_clear_report_marks_resolved(ctx, tmp_path):
    _seed(ctx)
    db_path = ctx.repository.path
    ctx.close()
    conn = _raw(db_path)
    conn.execute("INSERT INTO events (sequence, payload) VALUES (99999, '{\"foo\": 1}')")
    conn.commit()
    conn.close()
    recovered = create_context_with_recovery(db_path=db_path, data_dir=tmp_path,
                                             for_tests=True)
    recovered.close()
    assert db_state(tmp_path)['state'] == 'repaired'
    # un avvio pulito successivo archivia il rapporto: lo stato torna ok
    clean = create_context(db_path=db_path, data_dir=tmp_path, for_tests=True)
    clear_report(tmp_path)
    clean.close()
    assert db_state(tmp_path)['state'] == 'ok'


def test_narrator_seeds_diagnosis_conversation(ctx):
    """Il rapporto diventa una conversazione leggibile; il turno è best-effort."""
    from homun.application.recovery_narrator import seed_recovery_conversation
    report = {
        'mode': 'repaired',
        'quarantine_dir': '/tmp/quarantine',
        'tables': {'events': {'kept': 100, 'lost': 2}},
        'issues': [{'kind': 'row_invalid', 'table': 'events', 'detail': 'scartato'}],
    }
    conversation_id = seed_recovery_conversation(ctx, report)
    assert conversation_id is not None
    store = ctx.repository.load()
    conversation = store.conversations[conversation_id]
    assert conversation.title == 'Diagnosi motore'
    messages = [m for m in store.messages.values()
                if m.conversation_id == conversation_id and m.author_id == 'homun_engine']
    assert len(messages) == 1
    assert 'Ripristino database' in messages[0].text
    assert '100 conservate' in messages[0].text
    # idempotente: un secondo seed riusa la stessa conversazione
    again = seed_recovery_conversation(ctx, report)
    assert again == conversation_id
