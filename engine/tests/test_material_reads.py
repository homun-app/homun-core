"""Approval, integrity, idempotency and authority for authorized material reads."""
import json
from types import SimpleNamespace

import pytest

from homun.application.material_read_execution import execute
from homun.application.material_reads import approve, list_proposals, propose
from homun.application.material_ingest import ingest_file
from homun.context import create_context
from homun.domain.errors import ConflictError, PermissionDeniedError, ValidationError
from homun.domain.models import Actor


@pytest.fixture
def setup(tmp_path):
    ctx = create_context(db_path=tmp_path / 'ws.db', data_dir=tmp_path, for_tests=True)
    actor = Actor(id='person_fabio', workspace_id=ctx.workspace_id, display_name='Fabio')
    service = ctx.service
    project = service.apply(actor, 'project', 'project.create', {'name': 'Synthetic'})['project_id']
    conv = service.apply(actor, 'conversation', 'conversation.create', {'title': 'Notes', 'project_id': project})['conversation_id']
    work = service.apply(actor, 'work', 'work.create', {'conversation_id': conv, 'title': 'Notes', 'objective': 'Read'})['work_id']
    ctx.persist()
    material = ingest_file(ctx, actor, command_id='ingest', project_id=project,
                           filename='note.txt', data='Prima riga della nota.\nSeconda riga.'.encode())['material_id']
    body = dict(command_id='read', material_id=material, expected_version=1)
    yield ctx, actor, work, material, body
    ctx.close()


def confirmation(p):
    return dict(command_id='approve', digest=p['digest'], expected_version=p['expected_version'])


def confirm_intake(ctx, actor, work, *, capability='read_material', create_agent=True):
    from homun.application.intake import propose as intake_propose, confirm as intake_confirm
    ctx.models.complete = lambda *_a, **_k: SimpleNamespace(text=json.dumps({
        'title': 'Lettura documento', 'objective': 'Leggere il materiale caricato.', 'output': 'Artifact di lettura',
        'constraints': [], 'missing_information': [], 'suggested_agent_id': None,
        'new_agent': {'name': 'Lettore', 'role': 'Lettura materiali', 'instructions': 'Legge i materiali autorizzati'},
        'rationale': 'Lettura documentale', 'capability': capability,
    }))
    p = intake_propose(ctx, actor, work, {'command_id': 'intake', 'text': 'Leggi il documento caricato', 'expected_version': 1})
    intake_confirm(ctx, actor, work, p['id'], {'command_id': 'staff', 'digest': p['digest'],
                                               'expected_version': p['expected_version'], 'create_agent': create_agent})
    return ctx.repository.load().works[work].version


def test_confirmed_read_flows_to_review_with_one_artifact(setup):
    ctx, actor, work, material, body = setup
    version = confirm_intake(ctx, actor, work)
    p = propose(ctx, actor, work, {**body, 'expected_version': version})
    assert p['status'] == 'pending_approval'
    assert p['material']['sha256'] and p['tool_version'] == 'material-read-v1'
    approve(ctx, actor, work, p['id'], confirmation(p))
    execute(ctx, p['id'])
    execute(ctx, p['id'])  # DBOS replay: publication stays exactly once
    store = ctx.repository.load()
    assert store.works[work].status == 'review'
    assert len(store.artifacts) == 1
    artifact = next(iter(store.artifacts.values()))
    assert 'note.txt' in artifact.content and 'SHA-256' in artifact.content
    assert 'Prima riga della nota.' in artifact.content
    assert list_proposals(ctx, actor, work)['items'][0]['status'] == 'completed'
    assert len([m for m in store.messages.values() if m.author_id == 'homun_engine']) == 1


def test_read_requires_confirmed_matching_intake(setup):
    ctx, actor, work, material, body = setup
    confirm_intake(ctx, actor, work, capability='compare_csv')
    with pytest.raises(ConflictError):
        propose(ctx, actor, work, {**body, 'expected_version': ctx.repository.load().works[work].version})


def test_wrong_digest_and_double_approval(setup):
    ctx, actor, work, material, body = setup
    version = confirm_intake(ctx, actor, work)
    p = propose(ctx, actor, work, {**body, 'expected_version': version})
    with pytest.raises(ConflictError):
        approve(ctx, actor, work, p['id'], {**confirmation(p), 'digest': 'wrong'})
    approve(ctx, actor, work, p['id'], confirmation(p))
    approve(ctx, actor, work, p['id'], confirmation(p))
    execute(ctx, p['id'])
    assert len(ctx.repository.load().artifacts) == 1


def test_changed_material_invalidates_approval(setup):
    ctx, actor, work, material, body = setup
    version = confirm_intake(ctx, actor, work)
    p = propose(ctx, actor, work, {**body, 'expected_version': version})
    # Any new material version invalidates the bound approval.
    ctx.service.apply(actor, 'retitle', 'material.update',
                      {'material_id': material, 'expected_version': 1, 'title': 'Nota rinominata'})
    ctx.persist()
    with pytest.raises(ConflictError):
        approve(ctx, actor, work, p['id'], confirmation(p))
    assert not ctx.repository.load().artifacts


def test_denied_actor_cannot_read(setup):
    ctx, actor, work, material, body = setup
    version = confirm_intake(ctx, actor, work)
    p = propose(ctx, actor, work, {**body, 'expected_version': version})
    stranger = Actor(id='stranger', workspace_id=ctx.workspace_id, display_name='Stranger')
    with pytest.raises(PermissionDeniedError):
        list_proposals(ctx, stranger, work)
    with pytest.raises(PermissionDeniedError):
        approve(ctx, stranger, work, p['id'], confirmation(p))
    assert not ctx.repository.load().artifacts


def test_unreadable_material_rejected_upfront(setup):
    ctx, actor, work, material, body = setup
    version = confirm_intake(ctx, actor, work)
    store = ctx.repository.load()
    binary = ingest_file(ctx, actor, command_id='ingest-bin',
                         project_id=store.materials[material].project_id,
                         filename='blob.zip', data=b'\x00\x01\x02PK')[ 'material_id']
    with pytest.raises(ValidationError):
        propose(ctx, actor, work, {**body, 'material_id': binary, 'expected_version': version})
