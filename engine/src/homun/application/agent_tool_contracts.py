"""Shared native protocol and control/discovery argument contracts."""
from pydantic import Field, field_validator
from homun.application import agent_tools
from homun.models.agent_turn import ToolDefinition
from homun.tools.registry import ToolEntry

PROTOCOL = 'native-tools-v1'
QUESTION = ToolDefinition(name='request_user_input', description='Ask for required information unavailable through tools. Execution waits for the authorized human response.',
    input_schema={'type':'object', 'properties':{'question':{'type':'string','minLength':1,'maxLength':16000}},
                  'required':['question'],'additionalProperties':False})


class QuestionArguments(agent_tools.NoArguments):
    question: str = Field(min_length=1, max_length=16000)

    @field_validator('question')
    @classmethod
    def nonempty(cls, value):
        if not value.strip():
            raise ValueError('Question must contain text')
        return value


class DiscoveryArguments(agent_tools.NoArguments):
    query: str = Field(min_length=1, max_length=200)
    limit: int = Field(default=5, ge=1, le=20)


