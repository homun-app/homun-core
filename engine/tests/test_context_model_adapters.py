"""The front-door request keeps native roles and the exact current input; never calls a live endpoint."""
from pathlib import Path

from homun.application.sessions.front_door import tools
from homun.application.sessions.front_door.turn import _decision_messages
from homun.domain.roster import RosterEntry
from homun.models.conversation_context import ContextManifest, ConversationContext
from homun.models.registry import build_default_registry
from homun.models.types import ChatMessage


def context():
    return ConversationContext(messages=[
        ChatMessage(role='user', content='Compare the September price list.'),
        ChatMessage(role='assistant', content='Which country?'),
    ], manifest=ContextManifest(conversation_id='conv', current_message_id='now', cutoff_sequence=3))


def test_front_door_request_keeps_native_roles_and_exact_current_input(tmp_path: Path):
    registry = build_default_registry(tmp_path, for_tests=True)
    original = context()
    original.manifest.omitted_count = 4
    before = original.model_dump()
    text = '  Italy.\nUse EUR.  '
    roster = [RosterEntry(id='person_fabio', display_name='Fabio', kind='person')]
    catalog = tools.front_door_tools(registry, 'en')

    messages = _decision_messages(registry, 'en', original, roster, text, catalog)

    assert [m.role for m in messages] == ['system', 'user', 'assistant', 'user']
    assert [m.content for m in messages[1:3]] == ['Compare the September price list.', 'Which country?']
    assert messages[-1].content.endswith(text), 'the current input is verbatim, never trimmed'
    assert '4 authorized messages omitted' in messages[-1].content
    assert 'person_fabio | Fabio | person' in messages[-1].content
    assert original.model_dump() == before, 'the selected context is read, never edited'


def test_system_prompt_carries_the_tool_catalog_in_the_prompt_language(tmp_path: Path):
    registry = build_default_registry(tmp_path, for_tests=True)
    for language, marker in (('en', 'Propose a work agreement'), ('it', 'Proponi un accordo di lavoro')):
        catalog = tools.front_door_tools(registry, language)
        system = _decision_messages(registry, language, context(), [], 'ciao', catalog)[0]
        assert system.role == 'system'
        assert marker in system.content
        for name in (tools.ASK_CLARIFICATION, tools.PROPOSE_WORK, tools.PROPOSE_PLAN_CHANGE):
            assert name in system.content
