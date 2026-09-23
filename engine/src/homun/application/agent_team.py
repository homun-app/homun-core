"""Approved team bindings and bounded model consultation inside an adaptive run."""
import json
from pydantic import BaseModel, ConfigDict, Field
from homun.domain.errors import ConflictError, ValidationError
from homun.models.agent_turn import ToolDefinition


class Consultation(BaseModel):
    model_config = ConfigDict(extra='forbid')
    agent_id: str = Field(min_length=1, max_length=160)
    task: str = Field(min_length=1, max_length=3000)


def bind_team(store, team_id):
    if not team_id:
        return None
    team = store.teams.get(team_id)
    if team is None or team.status != 'active':
        raise ValidationError('Choose an active team')
    members = []
    for member_id in team.member_ids:
        agent = store.agents.get(member_id)
        if agent is None or agent.status != 'active':
            raise ValidationError('Team consultation currently requires active AI collaborators')
        members.append({'id': agent.id, 'name': agent.name, 'role': agent.role, 'revision': agent.revision})
    if not members or len(members) > 6:
        raise ValidationError('Select a team of 1 to 6 collaborators')
    return {'id': team.id, 'name': team.name, 'revision': team.revision,
            'coordinator_id': team.coordinator_id, 'members': members}


def validate_team(store, binding):
    if binding and bind_team(store, binding['id']) != binding:
        raise ConflictError('Team changed; create a new proposal')


def tool_definition(binding, executor_id):
    members = [m for m in binding['members'] if m['id'] != executor_id] if binding else []
    if not members:
        return []
    schema = Consultation.model_json_schema()
    schema['properties']['agent_id']['enum'] = [m['id'] for m in members]
    return [ToolDefinition(name='consult_collaborator',
        description='Ask a teammate to analyze the available observations. They return advice, not external actions. '
                    + json.dumps(members, ensure_ascii=False), input_schema=schema)]


