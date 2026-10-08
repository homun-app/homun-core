"""Bounded SSE/NDJSON framing and native tool delta assembly.

No deltas are executable until terminal provider evidence and normal native
response validation succeed. Progress events deliberately contain counts only
plus the assembled text/reasoning so live UI can follow the stream.
"""
import json

from homun.models.native_errors import (
    NativeModelError, MALFORMED, TRUNCATED, CLEAN_EOF, REPETITION,
)
from homun.models.repetition import RunawayStreamWatch

MAX_RESPONSE_BYTES = 4 * 1024 * 1024
MAX_FRAME_BYTES = 256 * 1024
MAX_FRAMES = 16384
MAX_ARGUMENT_CHARS = 65536

# Provider reasoning channel keys (OpenAI-compat + common aliases).
_REASONING_DELTA_KEYS = ('reasoning', 'reasoning_content', 'thinking')


class NativeStream:
    def __init__(self, *, ollama=False, on_delta=None):
        self.ollama, self.on_delta = ollama, on_delta
        self.buffer = b''
        self.event = []
        self.event_size = self.bytes = self.chunks = 0
        self.content = ''
        self.reasoning = ''
        self.calls = {}
        self.reason = None
        self.terminal = False
        self.finish_reason_seen = False
        self.usage = {}
        self.content_watch = RunawayStreamWatch()
        self.reasoning_watch = RunawayStreamWatch()

    def fail(self, text='Malformed native stream'):
        raise NativeModelError(MALFORMED, text, retryable=False)

    def feed(self, data):
        self.bytes += len(data)
        if self.bytes > MAX_RESPONSE_BYTES:
            self.fail('Native stream exceeds response limit')
        self.buffer += data
        while b'\n' in self.buffer:
            line, self.buffer = self.buffer.split(b'\n', 1)
            if len(line) > MAX_FRAME_BYTES:
                self.fail('Native stream exceeds frame limit')
            if self.terminal:
                if line.strip(): self.fail('Data follows native stream terminal')
                continue
            self.line(line.rstrip(b'\r'))
        if len(self.buffer) > MAX_FRAME_BYTES:
            self.fail('Native stream exceeds frame limit')

    def line(self, line):
        if self.ollama:
            if line.strip(): self.frame(line)
        elif not line:
            if self.event:
                self.frame(b'\n'.join(self.event))
                self.event, self.event_size = [], 0
        elif line.startswith(b'data:'):
            data = line[5:].lstrip(b' ')
            self.event_size += len(data)
            if self.event_size > MAX_FRAME_BYTES: self.fail('Native stream exceeds frame limit')
            self.event.append(data)
        elif line.startswith((b':', b'event:', b'id:', b'retry:')):
            pass
        else:
            self.fail('Invalid SSE framing')

    def frame(self, raw):
        self.chunks += 1
        if self.chunks > MAX_FRAMES: self.fail('Native stream exceeds fragment limit')
        if not self.ollama and raw == b'[DONE]':
            if self.reason is None:
                # Clean server close without finish_reason — not a transport drop.
                raise NativeModelError(
                    CLEAN_EOF,
                    'Server closed the stream without finish_reason (not a network error)',
                    retryable=False,
                )
            self.terminal = True
            return
        try:
            body = json.loads(raw)
            if not isinstance(body, dict): self.fail()
            self.capture_usage(body)
            if body.get('error'): self.fail('Provider reported a stream error')
            if self.ollama: self.ollama_delta(body)
            else: self.openai_delta(body)
        except (ValueError, TypeError, KeyError, AttributeError) as exc:
            self.fail('Invalid native stream fragment')
        if self.on_delta:
            event = {
                'type': 'native_stream_progress',
                'chunks': self.chunks,
                'text_chars': len(self.content),
                'tool_calls': len(self.calls),
                'text': self.content,
            }
            if self.reasoning:
                event['reasoning'] = self.reasoning
            self.on_delta(event)

    def capture_usage(self, body):
        raw = body if self.ollama else body.get('usage')
        keys = ('prompt_eval_count','eval_count') if self.ollama else ('prompt_tokens','completion_tokens')
        if isinstance(raw, dict):
            for key in keys:
                value = raw.get(key)
                if type(value) is int and value >= 0:
                    self.usage[key] = max(value,self.usage.get(key,0))

    def text(self, delta):
        content = delta.get('content')
        if content is not None:
            if not isinstance(content, str): self.fail()
            self.content += content
            if self.content_watch.feed(content):
                raise NativeModelError(
                    REPETITION, 'Stream cut: runaway repetition', retryable=False,
                )
        for key in _REASONING_DELTA_KEYS:
            value = delta.get(key)
            if value is None:
                continue
            if not isinstance(value, str): self.fail()
            self.reasoning += value
            if self.reasoning_watch.feed(value):
                raise NativeModelError(
                    REPETITION, 'Stream cut: runaway repetition', retryable=False,
                )

    def openai_delta(self, body):
        choices = body.get('choices')
        if not isinstance(choices, list) or len(choices) > 1: self.fail()
        if not choices: return  # usage-only terminal accounting chunk
        choice = choices[0]
        if choice.get('index', 0) != 0 or self.reason is not None: self.fail()
        delta = choice.get('delta')
        if not isinstance(delta, dict): self.fail()
        if delta.get('role', 'assistant') != 'assistant': self.fail()
        self.text(delta)
        calls = delta.get('tool_calls') or []
        if not isinstance(calls, list): self.fail()
        for call in calls:
            index = call.get('index')
            if type(index) is not int or not 0 <= index < 8: self.fail()
            target = self.calls.setdefault(index, {'id':'', 'type':'function', 'function':{'name':'','arguments':''}})
            if call.get('type', 'function') != 'function': self.fail()
            for key in ('id',):
                value = call.get(key)
                if value is not None:
                    if not isinstance(value, str): self.fail()
                    target[key] += value
                    if len(target[key]) > 1024: self.fail()
            function = call.get('function') or {}
            for key in ('name','arguments'):
                value = function.get(key)
                if value is not None:
                    if not isinstance(value, str): self.fail()
                    target['function'][key] += value
                    limit = MAX_ARGUMENT_CHARS if key == 'arguments' else 1024
                    if len(target['function'][key]) > limit: self.fail('Tool fragment exceeds limit')
        reason = choice.get('finish_reason')
        if reason is not None:
            if not isinstance(reason, str): self.fail()
            self.reason = reason
            self.finish_reason_seen = True

    def ollama_delta(self, body):
        if self.terminal: self.fail()
        message = body.get('message', {})
        if not isinstance(message, dict) or message.get('role', 'assistant') != 'assistant': self.fail()
        self.text(message)
        calls = message.get('tool_calls') or []
        if not isinstance(calls, list): self.fail()
        for call in calls:
            # Ollama emits complete argument objects, not OpenAI argument strings.
            function = call['function']
            if not isinstance(function.get('arguments'), dict): self.fail()
            if len(json.dumps(function['arguments'])) > MAX_ARGUMENT_CHARS: self.fail('Tool fragment exceeds limit')
            if len(self.calls) >= 8: self.fail('Too many streamed tool calls')
            self.calls[len(self.calls)] = call
        if body.get('done') is True:
            self.reason = body.get('done_reason')
            self.finish_reason_seen = self.reason is not None
            self.terminal = True
        elif body.get('done') is not False:
            self.fail('Ollama stream lacks done marker')

    def finish(self):
        if self.ollama and self.buffer.strip() and not self.terminal:
            self.line(self.buffer)
            self.buffer = b''
        if not self.terminal or self.reason is None:
            # Abrupt close / missing terminal evidence — distinct from clean EOF.
            raise NativeModelError(TRUNCATED, 'Stream lacks terminal evidence', retryable=False)
        if not self.ollama:
            if sorted(self.calls) != list(range(len(self.calls))): self.fail('Tool indices are not contiguous')
            if any(not c['id'] for c in self.calls.values()): self.fail('Streamed tools require provider call IDs')
        message = {'content':self.content, 'tool_calls':[self.calls[i] for i in sorted(self.calls)]}
        if self.ollama:
            return dict(message=message, done=True, done_reason=self.reason, **self.usage)
        return {'choices':[{'message':message,'finish_reason':self.reason}], 'usage':self.usage}

    def usage_response(self):
        return self.usage if self.ollama else {'usage':self.usage}
