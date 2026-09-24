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


class PtyTerminalArguments(BackgroundTerminalArguments):
    pty: bool = False


class TerminalSessionArguments(BaseModel):
    model_config = ConfigDict(extra='forbid',strict=True)
    session_id: str = Field(min_length=1,max_length=200)


class TerminalWriteArguments(BaseModel):
    model_config = ConfigDict(extra='forbid',strict=True)
    session_id: str = Field(min_length=1,max_length=200)
    data: str = Field(default='',max_length=4096)
    newline: bool = False


def entry(config):
    return entries(config)[0]


def entries(config):
    if config.get('policy')=='local-private-v1':
        return _local_entries(config)
    JobSpec(workspace_id='validation',run_id='validation',call_id='validation',image=config['image'],command='true')
    version=config.get('version',1)
    if version>=5:arguments=PtyTerminalArguments
    elif version>=3:arguments=BackgroundTerminalArguments
    elif version==2:arguments=TimedTerminalArguments
    else:arguments=TerminalArguments
    definition=ToolDefinition(name='terminal_execute',
        description=f"Propose a shell command in the run's isolated /workspace using image {config['image']}. No network. Each command waits for explicit human approval. Returns exit status and bounded logs after completion; do not claim completion before the result.",
        input_schema=arguments.model_json_schema())
    if version==2:
        definition.description+=' Set timeout_seconds (1..3600, default 300); the person reviews this limit before execution. Deadline enforcement requires Homun to be running.'
    if version>=5:
        definition.description=(
            f"Propose a shell command in the run's isolated /workspace using image {config['image']}. No network. "
            'Each command waits for explicit human approval. Without background, the result arrives after the process exits. '
            'With background true, the result arrives once the process is running and includes job_id; then use terminal_poll, terminal_wait, terminal_stop, or terminal_write. '
            'Set pty true only together with background to allocate a terminal. Homun answers device, cursor, and window queries. It is not a full screen emulator. '
            'Set timeout_seconds (1..3600, default 300). Deadline enforcement requires Homun to be running.')
    elif version>=4:
        definition.description=(
            f"Propose a shell command in the run's isolated /workspace using image {config['image']}. No network. "
            'Each command waits for explicit human approval. Without background, the result arrives after the process exits. '
            'With background true, the result arrives once the process is running and includes job_id; then use terminal_poll, terminal_wait, terminal_stop, or terminal_write. '
            'terminal_write sends bytes to that process stdin and does not start a container. There is no PTY. '
            'Set timeout_seconds (1..3600, default 300). Deadline enforcement requires Homun to be running.')
    elif version>=3:
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
    if version>=4:
        write = ('Send bytes to the stdin of a background session that was approved with input open. '
                 'Does not start or repeat a command. No PTY. Set newline true to append one newline.')
        if version>=5:
            write = ('Send bytes to the stdin of a background session that was approved with input open. '
                     'Does not start or repeat a command. Device queries on a terminal session are answered separately. '
                     'Set newline true to append one newline.')
        catalog.append(ToolEntry(ToolDefinition(name='terminal_write',
            description=write,
            input_schema=TerminalWriteArguments.model_json_schema()),'terminal','4',TerminalWriteArguments,replay='never'))
    return catalog


def _local_entries(config):
    """Commands on this computer. Version 1 is not a successor of the Docker contract."""
    if config.get('version', 1) != 1:
        raise ValueError('Unknown local terminal contract')
    definition = ToolDefinition(
        name='terminal_execute',
        description=(
            "Propose a shell command in this work's private directory on this computer. "
            "It is not a container, it is not offline, and it does not inherit environment variables. "
            "Absolute paths remain reachable. Each command waits for explicit human approval. "
            "Without background, the result arrives after the process exits. "
            "With background true, the result arrives once the process is running and includes job_id; "
            "then use terminal_poll, terminal_wait, or terminal_stop. "
            "Stdin and a terminal are not available. "
            "Set timeout_seconds (1..3600, default 300). Deadline enforcement requires Homun to be running."),
        input_schema=BackgroundTerminalArguments.model_json_schema())
    catalog = [ToolEntry(definition, 'terminal', '1', BackgroundTerminalArguments, replay='never')]
    session = TerminalSessionArguments.model_json_schema()
    catalog.append(ToolEntry(ToolDefinition(name='terminal_poll',
        description='Read the status and recent logs of a background terminal session you started. Does not wait or start a process.',
        input_schema=session), 'terminal', '1', TerminalSessionArguments))
    catalog.append(ToolEntry(ToolDefinition(name='terminal_wait',
        description='Wait until a background terminal session exits, then return its status and logs. Does not start a process. If the outcome is unknown, returns that state without retrying the command.',
        input_schema=session), 'terminal', '1', TerminalSessionArguments, replay='never'))
    catalog.append(ToolEntry(ToolDefinition(name='terminal_stop',
        description='Stop one background terminal session you started. Other sessions keep running. Does not start a process.',
        input_schema=session), 'terminal', '1', TerminalSessionArguments, replay='never'))
    return catalog


