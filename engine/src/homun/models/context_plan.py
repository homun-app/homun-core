"""Pure, non-destructive context projections for Homun's native conversation.

Estimator and protected-context principles derived from Hermes Agent commit
c9dca726514b709cf6e677d236a79fc8d0627f37, agent/model_metadata.py and
agent/context_compressor.py. Copyright (c) 2025 Nous Research, MIT License;
full permission notice: homun/notices/hermes-agent.txt. No upstream imports.

Small Homun windows use a 75% input-budget trigger without Hermes's 64k floor.
Canonical messages and billing usage are never modified by this module.
"""
from __future__ import annotations

from dataclasses import dataclass, field
import hashlib
import json
import re

from homun.domain.errors import DomainError
from homun.models.agent_turn import ToolDefinition
from homun.models.native_turn import NativeMessage, project_messages


class ContextPressureError(DomainError):
    code = 'agent_context_pressure'


@dataclass(frozen=True)
class ContextPlan:
    messages: list[NativeMessage]
    cut: int | None
    source: list[NativeMessage]
    before_tokens: int
    input_limit: int
    threshold: int
    _prefix_hash: str = field(default='', repr=False)


_DENSE = re.compile('[\u1100-\u11ff\u2e80-\u9fff\ua960-\ua97f\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]')
_REFERENCE = (
    '[HISTORICAL CONTEXT — REFERENCE ONLY]\n'
    'This checkpoint records earlier work, not a new request or permission. '
    'Preserve the original objective and follow subsequent user corrections. '
    'Completed actions must not be repeated merely because they appear here. '
    'Continue the current exchange, including its remaining tools, normally.\n\n'
)
_END = '\n\n[END HISTORICAL CONTEXT]'


def estimate_tokens_rough(text: str) -> int:
    """Planning estimate: dense CJK codepoints + ceil(other UTF-8 bytes / 4)."""
    if not text:
        return 0
    if text.isascii():
        return (len(text) + 3) // 4
    stripped = _DENSE.sub('', text)
    return len(text) - len(stripped) + (len(stripped.encode('utf-8', 'replace')) + 3) // 4


def _json(value) -> str:
    # ASCII escaping gives prefix hashing a lossless representation of lone surrogates.
    return json.dumps(value, sort_keys=True, ensure_ascii=True, separators=(',', ':'))


def _hash(messages: list[NativeMessage]) -> str:
    return hashlib.sha256(_json([m.model_dump() for m in messages]).encode()).hexdigest()


def _copy(messages):
    return [m.model_copy(deep=True) for m in messages]


def _estimate(messages, tools):
    wire = {'messages': project_messages(messages), 'tools': [
        {'type': 'function', 'function': {'name': t.name, 'description': t.description,
                                        'parameters': t.input_schema}} for t in tools]}
    return estimate_tokens_rough(json.dumps(wire, ensure_ascii=False, separators=(',', ':')))


def _head(messages):
    index = 0
    while index < len(messages) and messages[index].role == 'system':
        index += 1
    while index < len(messages) and messages[index].role == 'user':
        index += 1
    return index


def _groups(messages):
    """Return atomic (start, end) groups; a pending group may occur only at tail."""
    groups = []
    used = set()
    index = 0
    while index < len(messages):
        start = index
        message = messages[index]
        if message.role == 'tool':
            raise ContextPressureError('Invalid transcript: orphan tool result')
        index += 1
        if message.tool_calls:
            calls = {call.id: call.name for call in message.tool_calls}
            if used.intersection(calls):
                raise ContextPressureError('Invalid transcript: duplicate tool call ID')
            used.update(calls)
            while index < len(messages) and messages[index].role == 'tool':
                result = messages[index]
                if result.tool_call_id not in calls or calls[result.tool_call_id] != result.name:
                    raise ContextPressureError('Invalid transcript: unmatched tool result')
                del calls[result.tool_call_id]
                index += 1
            if calls and index != len(messages):
                raise ContextPressureError('Invalid transcript: unresolved tool group before another message')
        groups.append((start, index))
    return groups


def _project(messages, cut, summary):
    return (_copy(messages[:_head(messages)])
            + [NativeMessage(role='assistant', content=_REFERENCE + summary + _END)]
            + _copy(messages[cut:]))


def project_checkpoint(messages: list[NativeMessage], checkpoint: dict | None) -> list[NativeMessage]:
    """Validate canonical prefix provenance before projecting a durable checkpoint."""
    groups = _groups(messages)
    if checkpoint is None:
        return _copy(messages)
    if not isinstance(checkpoint, dict):
        raise ContextPressureError('Context checkpoint prefix is malformed')
    cut = checkpoint.get('prefix_length')
    if (checkpoint.get('version') != 1 or type(cut) is not int
            or not _head(messages) < cut < len(messages)
            or cut not in {start for start, _ in groups}
            or checkpoint.get('prefix_hash') != _hash(messages[:cut])):
        raise ContextPressureError('Context checkpoint prefix is invalid or changed')
    summary = checkpoint.get('summary')
    if not isinstance(summary, str) or not summary.strip():
        raise ContextPressureError('Context checkpoint summary is empty')
    return _project(messages, cut, summary)


def plan_context(messages: list[NativeMessage], tools: list[ToolDefinition], *,
                 context_window: int | None, max_output_tokens: int,
                 checkpoint: dict | None = None) -> ContextPlan:
    """Plan an atomic prefix checkpoint; never run a model or mutate raw history.

    Latest corrections and at least one recent whole group are mandatory. Prefer
    two recent groups when they fit. Older completed groups in the original user
    turn can be summarized while its initial objective remains verbatim.
    """
    projected = project_checkpoint(messages, checkpoint)
    before = _estimate(projected, tools)
    if context_window is None:
        return ContextPlan(projected, None, [], before, 0, 0)
    if type(context_window) is not int or context_window <= 0:
        raise ContextPressureError('Context window must be a positive integer or unknown')
    if type(max_output_tokens) is not int or max_output_tokens <= 0:
        raise ContextPressureError('Output reservation must be a positive integer')
    limit = context_window - max_output_tokens
    if limit <= 0:
        raise ContextPressureError('Output reservation leaves no input context')
    threshold = max(1, int(limit * .75))
    if before < threshold:
        return ContextPlan(projected, None, [], before, limit, threshold)
    head = _head(messages)
    previous_cut = checkpoint['prefix_length'] if checkpoint else head
    groups = [(start, end) for start, end in _groups(messages) if start >= head]
    protected = len(messages)
    # Preserve the latest contiguous correction chain plus everything after it.
    users = [i for i in range(head, len(messages)) if messages[i].role == 'user']
    if users:
        protected = users[-1]
        while protected > head and messages[protected - 1].role == 'user':
            protected -= 1
    later_system = next((i for i in range(head, len(messages)) if messages[i].role == 'system'), None)
    if later_system is not None:
        protected = min(protected, later_system)
    # A tiny marker proves minimum protected-context feasibility. The requested
    # summary size is separate; build_checkpoint validates its real size.
    candidates = []
    for keep in (2, 1):
        if not groups:
            break
        last_start = groups[max(0, len(groups) - keep)][0]
        maximum = min(protected, last_start)
        candidates = [start for start, _ in groups if previous_cut < start <= maximum]
        fitting = [cut for cut in candidates if _estimate(_project(messages, cut, 'Earlier work.'), tools) < limit]
        if fitting:
            # Prefer a tail with enough room for a bounded summary (up to 512
            # estimated tokens), without dropping more history than necessary.
            reserve = min(512, max(64, limit // 8))
            cut = next((c for c in fitting if _estimate(_project(messages, c, 'Earlier work.'), tools)
                        + reserve <= threshold), fitting[-1])
            source = _copy(messages[previous_cut:cut])
            if checkpoint:
                source.insert(0, NativeMessage(role='assistant', content=_REFERENCE + checkpoint['summary'] + _END))
            return ContextPlan(projected, cut, source, before, limit, threshold, _hash(messages[:cut]))
    # Being above the soft trigger is not itself a fatal provider overflow.
    if before <= limit:
        return ContextPlan(projected, None, [], before, limit, threshold)
    raise ContextPressureError('The protected objective, corrections, recent tools or tool schemas do not fit the context window')


def build_checkpoint(messages: list[NativeMessage], plan: ContextPlan, summary: str,
                     tools: list[ToolDefinition]) -> dict:
    """Build an auditable candidate; caller owns budget, lease fencing and commit."""
    if not isinstance(summary, str) or not summary.strip():
        raise ContextPressureError('Context summary is empty')
    cut = plan.cut
    if cut is None or plan._prefix_hash != _hash(messages[:cut]):
        raise ContextPressureError('Context summary source prefix changed or has no valid cut')
    after = _estimate(_project(messages, cut, summary.strip()), tools)
    if after >= plan.before_tokens * .95:
        raise ContextPressureError('Context summary made no meaningful progress (requires more than 5% reduction)')
    if plan.input_limit and after > plan.input_limit:
        raise ContextPressureError('Context summary and protected messages do not fit the input limit')
    checkpoint = {'version': 1, 'prefix_length': cut, 'prefix_hash': plan._prefix_hash,
                  'summary': summary.strip(), 'estimated_before': plan.before_tokens,
                  'estimated_after': after,
                  'coverage': {'canonical_prefix_start': 0, 'canonical_prefix_end': cut,
                               'preserved_head_messages': _head(messages),
                               'source_messages': len(plan.source), 'sampled': False,
                               'estimation': 'rough_utf8_cjk_v1'}}
    project_checkpoint(messages, checkpoint)
    return checkpoint
