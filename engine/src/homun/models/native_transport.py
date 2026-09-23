"""Native tool transport for OpenAI-compatible and local Ollama connections."""
from homun.domain.ids import new_id
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
        raise ValueError('Summary response must not request tools')
    return result


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
    if ollama:
        payload.update(think=False, options={'temperature': 0, 'num_predict': limits.max_output_tokens})
        if limits.context_window is not None:
            payload['options']['num_ctx'] = limits.context_window
        response = provider._post_ollama_chat(payload)
    else:
        payload.update(temperature=0, max_tokens=limits.max_output_tokens)
        response = provider._post('/chat/completions', payload, api_key=key)
    message = parse_response(response, ollama=ollama)
    if ollama:
        input_tokens, output_tokens = response.get('prompt_eval_count'), response.get('eval_count')
    else:
        usage = response.get('usage')
        if usage is None:
            usage = {}
        if not isinstance(usage, dict):
            raise ValueError('Malformed native usage metadata')
        input_tokens, output_tokens = usage.get('prompt_tokens'), usage.get('completion_tokens')
    return NativeResult(message=message, usage=UsageEntry(
        id=new_id('usage'), provider_id=provider.provider_id, model_id=model,
        input_tokens=input_tokens, output_tokens=output_tokens,
        status='ok' if input_tokens is not None and output_tokens is not None else 'unknown'))
