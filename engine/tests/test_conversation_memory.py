"""Memoria conversazionale: la persona è riconosciuta anche senza lavoro collegato."""
import pytest

from homun.application.command_delivery import admit
from homun.application.command_types import CommandRequest
from homun.application.conversation_context import compose_conversation_context
from homun.context import create_context
from homun.domain.models import Actor, Work
from homun.domain.states import WorkStatus
from homun.memory.types import MemoryNote


class FakeMemory:
    """Porta memoria minimale: basta filtrare per le tre forme di chiamata usate."""

    def __init__(self, notes):
        self.notes = notes

    def list(self, *, work_id=None, project_id=None, scope=None, subject_id=None,
             include_deleted=False):
        selected = []
        for note in self.notes:
            if scope is not None and (note.scope != scope or note.subject_id != subject_id):
                continue
            if scope is None and work_id is not None and note.work_id != work_id:
                continue
            if scope is None and project_id is not None and note.project_id != project_id:
                continue
            selected.append(note)
        return selected


def note(nid, text, **kwargs):
    return MemoryNote(id=nid, workspace_id='ws_test', text=text, created_by='owner', **kwargs)


@pytest.fixture
def plain(tmp_path):
    """Conversazione senza lavori collegati: il percorso che prima non vedeva memoria."""
    ctx = create_context(db_path=tmp_path / 'ctx.db', data_dir=tmp_path, for_tests=True)
    actor = Actor(id='owner', workspace_id=ctx.workspace_id, display_name='Owner')
    with ctx.repository.transaction() as store:
        svc = ctx.service.for_store(store)
        conv = svc.apply(actor, 'conv', 'conversation.create', {'title': 'Chat'})['conversation_id']
    yield ctx, actor, conv
    ctx.close()


def compose(ctx, actor, conv, memory):
    delivery = admit(ctx, actor, CommandRequest(command_id='current',
        type='conversation.post_message', payload={'conversation_id': conv, 'text': 'Ciao'}))
    return compose_conversation_context(ctx.repository.load(), actor, conv,
                                        delivery.result['message_id'], None, memory=memory)


def test_person_memory_reaches_plain_conversation(plain):
    ctx, actor, conv = plain
    memory = FakeMemory([note('p1', 'Il colore preferito di Fabio è il teal', scope='person',
                              subject_id='owner')])
    context = compose(ctx, actor, conv, memory)
    assert '[Contesto della conversazione' in context.preamble
    assert 'Memoria personale approvata' in context.preamble
    assert 'teal' in context.preamble


def test_other_persons_memory_stays_out(plain):
    ctx, actor, conv = plain
    memory = FakeMemory([note('p2', 'Il colore preferito di Marta è il rosso', scope='person',
                              subject_id='person_marta')])
    context = compose(ctx, actor, conv, memory)
    assert 'rosso' not in context.preamble


def test_pending_person_note_not_injected(plain):
    ctx, actor, conv = plain
    memory = FakeMemory([note('p3', 'bozza in attesa', scope='person', subject_id='owner',
                              status='rectified')])
    context = compose(ctx, actor, conv, memory)
    assert 'bozza in attesa' not in context.preamble


def test_project_memory_without_work(plain):
    ctx, actor, conv = plain
    with ctx.repository.transaction() as store:
        project = ctx.service.for_store(store).apply(
            actor, 'proj', 'project.create', {'name': 'Catalogo'})['project_id']
        store.conversations[conv].project_id = project
    memory = FakeMemory([
        note('q1', 'Il listino ha otto colonne', scope='project', project_id=project),
        note('q2', 'nota legata a un lavoro', scope='project', project_id=project, work_id='work_x'),
    ])
    context = compose(ctx, actor, conv, memory)
    assert 'otto colonne' in context.preamble
    assert 'nota legata a un lavoro' not in context.preamble


def test_empty_memory_keeps_preamble_silent(plain):
    ctx, actor, conv = plain
    context = compose(ctx, actor, conv, FakeMemory([]))
    assert context.preamble == ''


def test_work_linked_conversation_keeps_person_memory(plain):
    ctx, actor, conv = plain
    with ctx.repository.transaction() as store:
        store.works['work_1'] = Work(id='work_1', workspace_id=ctx.workspace_id,
            title='Confronto', objective='Verificare', status=WorkStatus.DRAFT,
            primary_conversation_id=conv, requester_id=actor.id, owner_id=actor.id)
    memory = FakeMemory([
        note('w1', 'allinea le colonne prima dei totali', work_id='work_1', scope='project',
             project_id=None),
        note('p4', 'preferisce risposte brevi', scope='person', subject_id='owner'),
    ])
    delivery = admit(ctx, actor, CommandRequest(command_id='current2',
        type='conversation.post_message', payload={'conversation_id': conv, 'text': 'Ciao'}))
    context = compose_conversation_context(ctx.repository.load(), actor, conv,
                                           delivery.result['message_id'],
                                           ctx.repository.load().works['work_1'], memory=memory)
    assert 'Memoria di lavoro approvata' in context.preamble
    assert 'allinea le colonne' in context.preamble
    assert 'Memoria personale approvata' in context.preamble
    assert 'risposte brevi' in context.preamble
