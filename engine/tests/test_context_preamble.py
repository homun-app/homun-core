"""Authorized work-state preamble: provenance, permissions, invalidation."""
import hashlib
import json
from types import SimpleNamespace

import pytest

from homun.application.command_delivery import admit, complete
from homun.application.command_types import CommandRequest
from homun.application.conversation_context import (compose_conversation_context,
                                                    revalidate_context)
from homun.context import create_context
from homun.domain.errors import PermissionDeniedError, ValidationError
from homun.domain.models import Actor, MaterialVersion, Work
from homun.domain.states import WorkStatus
from homun.memory.types import MemoryNote
from homun.models.conversation_context import ContextManifest, ContextResource, ContextSource
from homun.models.interpretation import MessageInterpretation


@pytest.fixture
def setup(tmp_path):
    ctx = create_context(db_path=tmp_path / 'ctx.db', data_dir=tmp_path, for_tests=True)
    actor = Actor(id='owner', workspace_id=ctx.workspace_id, display_name='Owner')
    with ctx.repository.transaction() as store:
        svc = ctx.service.for_store(store)
        conv = svc.apply(actor, 'conv', 'conversation.create', {'title': 'Context'})['conversation_id']
        project = svc.apply(actor, 'project', 'project.create', {'name': 'Progetto'})['project_id']
        store.works['work_1'] = Work(id='work_1', workspace_id=ctx.workspace_id,
            title='Confronto listini', objective='Verificare variazioni',
            status=WorkStatus.DRAFT, primary_conversation_id=conv, project_id=project,
            requester_id=actor.id, owner_id=actor.id)
    yield ctx, actor, conv, project
    ctx.close()


def post(setup, *, text='Come procediamo?', command_id='current'):
    ctx, actor, conv, _ = setup
    return admit(ctx, actor, CommandRequest(command_id=command_id,
        type='conversation.post_message', payload={'conversation_id': conv, 'text': text}))


def compose(setup, memory=None):
    ctx, actor, conv, _ = setup
    delivery = post(setup)
    return compose_conversation_context(ctx.repository.load(), actor, conv,
                                        delivery.result['message_id'],
                                        ctx.repository.load().works['work_1'], memory=memory)


def add_material(setup, *, mid='mat_1', title='Listino settembre', version=1):
    ctx, actor, conv, project = setup
    digest = hashlib.sha256(f'{mid}:{version}'.encode()).hexdigest()
    with ctx.repository.transaction() as store:
        store.materials[mid] = MaterialVersion(id=mid, workspace_id=ctx.workspace_id,
            project_id=project, title=title, kind='note', text='',
            content_hash=digest, byte_size=7, version=version, status='active',
            storage_relpath=f'materials/{mid}/v{version}/original')
    return digest


def test_preamble_carries_work_state_and_material_references(setup):
    digest = add_material(setup)
    context = compose(setup)
    assert 'Confronto listini' in context.preamble
    assert 'Verificare variazioni' in context.preamble
    assert 'Listino settembre' in context.preamble
    assert digest[:12] in context.preamble
    material_resource = next(r for r in context.manifest.resources if r.resource_type == 'material')
    assert material_resource.version == 1 and material_resource.content_hash == digest
    # References only: the stored bytes never enter the composed context.
    assert 'materials/mat_1' not in context.preamble


def test_confirmed_agreement_is_in_the_preamble(setup):
    ctx, actor, conv, project = setup
    brief = {'title': 'Confronto listini', 'objective': 'Variazioni di prezzo.', 'output': 'Report e CSV',
             'constraints': ['Nessuna conversione valutaria'], 'missing_information': [], 'suggested_agent_id': None,
             'new_agent': {'name': 'Analista', 'role': 'Analisi', 'instructions': 'Confronta i listini autorizzati'},
             'rationale': 'ok', 'capability': 'compare_csv', 'changed_fields': []}
    ctx.models.complete = lambda *_a, **_k: SimpleNamespace(text=json.dumps(brief))
    from homun.application.intake import confirm as intake_confirm
    from homun.application.intake import propose as intake_propose
    p = intake_propose(ctx, actor, 'work_1', {'command_id': 'i1', 'text': 'Confronta i listini', 'expected_version': 1})
    intake_confirm(ctx, actor, 'work_1', p['id'], {'command_id': 'ok', 'digest': p['digest'],
                                                   'expected_version': 1, 'create_agent': True})
    context = compose(setup)
    assert 'Accordo confermato: Confronto listini' in context.preamble
    assert 'compare_csv' in context.preamble
    assert 'Nessuna conversione valutaria' in context.preamble


def test_memory_notes_are_bounded_and_only_approved(setup):
    class FakeMemory:
        def list(self, *, work_id=None, project_id=None, include_deleted=False):
            if work_id is None:
                return []
            notes = [MemoryNote(id=f'n{i}', workspace_id='ws_local', text=f'nota operativa {i}',
                                work_id=work_id, status='approved', created_by='person_fabio')
                     for i in range(7)]
            notes.append(MemoryNote(id='nd', workspace_id='ws_local', text='nota cancellata',
                                    work_id=work_id, status='deleted'))
            return notes
    context = compose(setup, memory=FakeMemory())
    lines = [line for line in context.preamble.split('\n') if line.startswith('- nota')]
    assert len(lines) == 5
    assert 'nota cancellata' not in context.preamble


def test_material_change_invalidates_revalidation(setup):
    add_material(setup)
    context = compose(setup)
    ctx, actor, conv, project = setup
    ctx.service.apply(actor, 'bump', 'material.update',
                      {'material_id': 'mat_1', 'expected_version': 1, 'title': 'Listino v2'})
    ctx.persist()
    with pytest.raises(ValidationError):
        revalidate_context(ctx.repository.load(), actor, context.manifest)


def test_revoked_actor_cannot_revalidate(setup):
    add_material(setup)
    context = compose(setup)
    ctx, actor, conv, project = setup
    stranger = Actor(id='stranger', workspace_id=ctx.workspace_id, display_name='Stranger')
    with pytest.raises(PermissionDeniedError):
        revalidate_context(ctx.repository.load(), stranger, context.manifest)


def test_legacy_manifest_without_material_identity_still_runs_identity_checks(setup):
    ctx, actor, conv, _ = setup
    delivery = post(setup, command_id='legacy')
    message = ctx.repository.load().messages[delivery.result['message_id']]
    manifest = ContextManifest(version=1, conversation_id=conv,
                               current_message_id=message.id, cutoff_sequence=1,
                               sources=[ContextSource(message_id=message.id, event_sequence=1,
                                                      content_hash='f' * 64)],
                               resources=[ContextResource(resource_type='project', resource_id='proj_x')])
    # The forged source fails identity (inaccessible or changed) even without
    # material fields: legacy manifests still get the full gate.
    with pytest.raises((ValidationError, PermissionDeniedError)):
        revalidate_context(ctx.repository.load(), actor, manifest)


def test_preamble_reaches_the_interpretation_call(setup, monkeypatch):
    add_material(setup)
    ctx, actor, conv, project = setup
    seen = []
    original = ctx.models.interpret

    def spy(text, *, roster, conversation_context=None, context=None, **kw):
        seen.append(conversation_context)
        return MessageInterpretation(kind='reply', text='Ricevuto')
    monkeypatch.setattr(ctx.models, 'interpret', spy)
    result = complete(ctx, post(setup))
    assert result.get('assistant_text') == 'Ricevuto'
    assert 'Listino settembre' in seen[0].preamble
    assert seen[0].manifest.version == 2
