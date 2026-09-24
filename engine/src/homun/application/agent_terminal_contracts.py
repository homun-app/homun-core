"""Pure terminal tool contract; no application lifecycle imports."""
from pydantic import BaseModel, ConfigDict, Field
from homun.execution.contracts import JobSpec
from homun.models.agent_turn import ToolDefinition
from homun.tools.registry import ToolEntry


class TerminalArguments(BaseModel):
    model_config = ConfigDict(extra='forbid',strict=True)
    command: str = Field(min_length=1,max_length=16000)


def entry(config):
    JobSpec(workspace_id='validation',run_id='validation',call_id='validation',image=config['image'],command='true')
    return ToolEntry(ToolDefinition(name='terminal_execute',
        description=f"Propose a shell command in the run's isolated /workspace using image {config['image']}. No network. Each command waits for explicit human approval. Returns exit status and bounded logs after completion; do not claim completion before the result.",
        input_schema=TerminalArguments.model_json_schema()),'terminal','1',TerminalArguments,replay='never')


