"""Capability registry: single source of truth, grounded availability, contract."""
import json
from types import SimpleNamespace
from typing import get_args

import pytest
from fastapi.testclient import TestClient

from homun.application.material_ingest import ingest_file
from homun.context import create_context, reset_context_for_tests
from homun.domain.capabilities import REGISTRY, TRANSPORT_IDS, require_capability
from homun.domain.errors import ValidationError
from homun.domain.models import Actor
from homun.policy.capabilities import capability_catalog
from homun.routes.intake import IntakeProposal


@pytest.fixture
def setup(tmp_path):
    ctx = create_context(db_path=tmp_path / 'ws.db', data_dir=tmp_path, for_tests=True)
    actor = Actor(id='person_fabio', workspace_id=ctx.workspace_id, display_name='Fabio')
    project = ctx.service.apply(actor, 'project', 'project.create', {'name': 'Synthetic'})['project_id']
    ctx.persist()
    yield ctx, actor, project
    ctx.close()


def test_registry_rejects_unknown_and_stays_in_sync_with_transport():
    assert require_capability('compare_csv').kind == 'executable'
    assert require_capability('general').kind == 'preparation'
    with pytest.raises(ValidationError):
        require_capability('browse_web')
    assert set(REGISTRY) == set(TRANSPORT_IDS)
    assert set(REGISTRY) == set(get_args(IntakeProposal.model_fields['capability'].annotation))


def test_comparison_tool_identity_comes_from_the_registry():
    from homun.application.price_comparison_policy import TOOL_VERSION
    assert TOOL_VERSION == REGISTRY['compare_csv'].tool_version == 'price-comparison-v1'
    assert REGISTRY['compare_csv'].limits['max_rows'] == 10000
    assert REGISTRY['compare_csv'].limits['max_attempts'] == 3


def test_catalog_reports_real_readiness_per_actor(setup):
    ctx, actor, project = setup
    empty = {item['id']: item for item in capability_catalog(ctx.repository.load(), actor)}
    assert empty['compare_csv']['ready'] is False
    assert empty['compare_csv']['eligible_materials'] == 0
    assert empty['general']['ready'] is True
    for i in range(2):
        ingest_file(ctx, actor, command_id=f'ingest-{i}', project_id=project,
                    filename=f'prices-{i}.csv',
                    data=f'sku,name,price,currency\nA,Alpha,{10 + i},EUR\n'.encode())
    stocked = {item['id']: item for item in capability_catalog(ctx.repository.load(), actor)}
    assert stocked['compare_csv']['ready'] is True
    assert stocked['compare_csv']['eligible_materials'] == 2
    stranger = Actor(id='stranger', workspace_id=ctx.workspace_id, display_name='Stranger')
    denied = {item['id']: item for item in capability_catalog(ctx.repository.load(), stranger)}
    assert denied['compare_csv']['ready'] is False
    assert denied['compare_csv']['eligible_materials'] == 0


def test_capabilities_http_contract(setup):
    from homun.app import create_app
    ctx, actor, project = setup
    reset_context_for_tests(ctx)
    try:
        with TestClient(create_app()) as client:
            response = client.get(f'/v1/workspaces/{ctx.workspace_id}/capabilities',
                                  headers={'X-Homun-Actor-Id': actor.id})
            assert response.status_code == 200, response.text
            items = {item['id']: item for item in response.json()['items']}
            assert set(items) == set(REGISTRY)
            assert items['compare_csv']['kind'] == 'executable'
            assert items['compare_csv']['tool_version'] == 'price-comparison-v1'
            assert items['general']['kind'] == 'preparation'
            assert client.get('/v1/workspaces/other/capabilities').status_code == 404
    finally:
        reset_context_for_tests(None)


def test_intake_synthesis_is_grounded_in_the_registered_catalog(setup):
    from homun.models.intake import synthesize
    ctx, actor, project = setup
    seen = []

    class Capture:
        def complete(self, messages):
            seen.extend(messages)
            brief = {'title': 'Confronto listini', 'objective': 'Variazioni di prezzo.',
                     'output': 'Report e CSV', 'constraints': [], 'missing_information': [],
                     'suggested_agent_id': None, 'new_agent': None,
                     'rationale': 'ok', 'capability': 'general'}
            return SimpleNamespace(text=json.dumps(brief))

    capabilities = capability_catalog(ctx.repository.load(), actor)
    synthesize(Capture(), 'Confronta i listini', [], capabilities=capabilities)
    user_payload = json.loads(seen[-1].content)
    assert [item['id'] for item in user_payload['capabilities']] == ['compare_csv', 'read_material', 'general']
    # Readiness stays queryable on the HTTP endpoint, never model-facing: it
    # made small models decline executable work before files were uploaded.
    # IO detail (inputs/effects/prerequisites) stays: it anchors the output
    # language and never caused the downgrade.
    for item in user_payload['capabilities']:
        assert 'ready' not in item and 'eligible_materials' not in item
        assert 'inputs' in item or item['id'] == 'general'
    system_prompt = seen[0].content
    assert 'compare_csv (eseguibile dal motore)' in system_prompt
    assert REGISTRY['compare_csv'].summary in system_prompt
    assert 'general (solo preparazione' in system_prompt
