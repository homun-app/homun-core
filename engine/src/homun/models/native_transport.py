"""Native tool transport for OpenAI-compatible and local Ollama connections.

No retries here: transient recovery is durable and lives in the agent run
(application/agent_recovery.py). What this transport guarantees is honesty —
provider-reported usage is extracted before response validation, so a rejected
reply still charges its real counters, and every failure leaves as a typed
NativeModelError instead of a raw provider body.
"""
from homun.domain.ids import new_id
from homun.models.native_errors import NativeModelError, classify_response, classify_transport
from homun.models.native_turn import NativeResult, parse_response, project_messages
from homun.models.types import UsageEntry
from homun.models.port import ContextLimits


def complete_tools(provider, messages, *, tools, model_id=None, context_window=None, max_output_tokens=8192):
    return _complete(provider, messages, tools=tools, model_id=model_id,
                     context_window=context_window, max_output_tokens=max_output_tokens)


def complete_summary(provider, messages, *, model_id=None, context_window=None, max_output_tokens=8192):
    result = _complete(provider, messages, tools=None, model_id=model_id,
                       context_window=context_window, max_output_tokens=max_output_tokens)
    if result.message.tool_calls:
        usage = result.usage.model_copy(update={'status': 'error', 'error_code': 'agent_model_malformed'})
        raise NativeModelError('agent_model_malformed', 'Summary response must not request tools',
                               usage=usage)
    return result


def usage_from_response(response, *, provider_id, model_id, ollama) -> UsageEntry:
    """Reported counters even when the envelope later fails validation."""
    body = response if isinstance(response, dict) else {}
    if ollama:
        raw_input, raw_output = body.get('prompt_eval_count'), body.get('eval_count')
    else:
        usage = body.get('usage')
        usage = usage if isinstance(usage, dict) else {}
        raw_input, raw_output = usage.get('prompt_tokens'), usage.get('completion_tokens')

    def counter(value):
        return value if type(value) is int and value >= 0 else None

    input_tokens, output_tokens = counter(raw_input), counter(raw_output)
    return UsageEntry(id=new_id('usage'), provider_id=provider_id, model_id=model_id,
                      input_tokens=input_tokens, output_tokens=output_tokens,
                      status='ok' if input_tokens is not None and output_tokens is not None else 'unknown')


def _complete(provider, messages, *, tools, model_id, context_window, max_output_tokens):
    limits = ContextLimits(context_window=context_window, max_output_tokens=max_output_tokens)
    key = provider._api_key()
    if not key:
        raise RuntimeError('OpenAI-compatible provider has no credentials')
    model = model_id or provider.default_model
    ollama = provider._ollama_native_root() is not None
    payload = {'model': model, 'messages': project_messages(messages, ollama=ollama), 'stream': False}
    if tools is not None:
        payload['tools'] = [{'type': 'function', 'function': {'name': t.name,
                            'description': t.description, 'parameters': t.input_schema}} for t in tools]
    try:
        if ollama:
            payload.update(think=False, options={'temperature': 0, 'num_predict': limits.max_output_tokens})
            if limits.context_window is not None:
                payload['options']['num_ctx'] = limits.context_window
            response = provider._post_ollama_chat(payload)
        else:
            payload.update(temperature=0, max_tokens=limits.max_output_tokens)
            response = provider._post('/chat/completions', payload, api_key=key)
    except Exception as exc:
        raise classify_transport(exc) from exc
    usage = usage_from_response(response, provider_id=provider.provider_id, model_id=model, ollama=ollama)
    try:
        message = parse_response(response, ollama=ollama)
    except ValueError as exc:
        raise classify_response(exc, usage=usage) from exc
    return NativeResult(message=message, usage=usage)
