"""Pure terminal tool contract; no application lifecycle imports."""
from pydantic import BaseModel, ConfigDict, Field
from homun.execution.contracts import JobSpec
from homun.models.agent_turn import ToolDefinition
from homun.tools.registry import ToolEntry


class TerminalArguments(BaseModel):
    model_config = ConfigDict(extra='forbid',strict=True)
    command: str = Field(min_length=1,max_length=16000)


class TimedTerminalArguments(TerminalArguments):
    timeout_seconds: int = Field(default=300,ge=1,le=3600)


class BackgroundTerminalArguments(TimedTerminalArguments):
    background: bool = False


class TerminalSessionArguments(BaseModel):
    model_config = ConfigDict(extra='forbid',strict=True)
    session_id: str = Field(min_length=1,max_length=200)


def entry(config):
    return entries(config)[0]


def entries(config):
    JobSpec(workspace_id='validation',run_id='validation',call_id='validation',image=config['image'],command='true')
    version=config.get('version',1)
    if version>=3:arguments=BackgroundTerminalArguments
    elif version==2:arguments=TimedTerminalArguments
    else:arguments=TerminalArguments
    definition=ToolDefinition(name='terminal_execute',
        description=f"Propose a shell command in the run's isolated /workspace using image {config['image']}. No network. Each command waits for explicit human approval. Returns exit status and bounded logs after completion; do not claim completion before the result.",
        input_schema=arguments.model_json_schema())
    if version==2:
        definition.description+=' Set timeout_seconds (1..3600, default 300); the person reviews this limit before execution. Deadline enforcement requires Homun to be running.'
    if version>=3:
        definition.description=(
            f"Propose a shell command in the run's isolated /workspace using image {config['image']}. No network. "
            'Each command waits for explicit human approval. Without background, the result arrives after the process exits. '
            'With background true, the result arrives once the process is running and includes job_id; then use terminal_poll, terminal_wait, or terminal_stop. '
            'Stdin and PTY are not available. Set timeout_seconds (1..3600, default 300). Deadline enforcement requires Homun to be running.')
    catalog=[ToolEntry(definition,'terminal',str(version),arguments,replay='never')]
    if version<3:return catalog
    session=TerminalSessionArguments.model_json_schema()
    catalog.append(ToolEntry(ToolDefinition(name='terminal_poll',
        description='Read the status and recent logs of a background terminal session you started. Does not wait or start a process.',
        input_schema=session),'terminal','3',TerminalSessionArguments))
    catalog.append(ToolEntry(ToolDefinition(name='terminal_wait',
        description='Wait until a background terminal session exits, then return its status and logs. Does not start a process. If the outcome is unknown, returns that state without retrying the command.',
        input_schema=session),'terminal','3',TerminalSessionArguments,replay='never'))
    catalog.append(ToolEntry(ToolDefinition(name='terminal_stop',
        description='Stop one background terminal session you started. Other sessions keep running. Does not start a process.',
        input_schema=session),'terminal','3',TerminalSessionArguments,replay='never'))
    return catalog


