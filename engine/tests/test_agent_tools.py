"""Tool execution stays inside selected immutable sources."""
import pytest
from homun.context import create_context
from homun.domain.models import Actor
from homun.application.material_ingest import ingest_file
from homun.materials.source import verify_material
from homun.domain.errors import PermissionDeniedError, ConflictError, ValidationError


@pytest.fixture
def sources(tmp_path):
    ctx = create_context(db_path=tmp_path/'ws.db', data_dir=tmp_path, for_tests=True)
    actor = Actor(id='person_a', workspace_id=ctx.workspace_id, display_name='A')
    project = ctx.service.apply(actor, 'p', 'project.create', {'name':'Progetto'})['project_id']
    ctx.persist()
    ids = [ingest_file(ctx, actor, command_id=f'file{i}', project_id=project,
        filename=f'file{i}.txt', data=text.encode())['material_id']
        for i,text in enumerate(['Consegna entro venerdì.\nCosto cento euro.', 'Documento non selezionato'])]
    binding, _ = verify_material(ctx, ctx.repository.load(), actor, ids[0], max_bytes=2097152)
    yield ctx, actor, [binding], ids[1]
    ctx.close()


def test_tools_read_page_and_find_text(sources):
    from homun.application.agent_tools import run_tool
    ctx, actor, bindings, _ = sources
    result = run_tool(ctx, actor, bindings, 'read_material', {'material_id': bindings[0]['id'], 'offset': 0, 'limit': 12})
    assert result['text'] == 'Consegna ent'
    assert result['next_offset'] == 12
    found = run_tool(ctx, actor, bindings, 'search_materials', {'query': 'venerdì'})
    assert found['matches'][0]['material_id'] == bindings[0]['id']
    assert 'venerdì' in found['matches'][0]['text']


def test_unselected_or_changed_source_never_read(sources):
    from homun.application.agent_tools import run_tool
    ctx, actor, bindings, other = sources
    with pytest.raises(PermissionDeniedError):
        run_tool(ctx, actor, bindings, 'read_material', {'material_id': other})
    with ctx.repository.transaction() as store:
        store.materials[bindings[0]['id']].version += 1
    with pytest.raises(ConflictError):
        run_tool(ctx, actor, bindings, 'read_material', {'material_id': bindings[0]['id']})


def test_tool_arguments_are_strict_and_bounded(sources):
    from homun.application.agent_tools import run_tool
    ctx, actor, bindings, _ = sources
    for arguments in [{'material_id': bindings[0]['id'], 'offset': -1},
                      {'material_id': bindings[0]['id'], 'limit': 999999},
                      {'material_id': bindings[0]['id'], 'path': '/etc/passwd'}]:
        with pytest.raises(ValidationError):
            run_tool(ctx, actor, bindings, 'read_material', arguments)
