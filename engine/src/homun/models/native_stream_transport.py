"""Single-attempt native streaming HTTP with active cancellation while idle."""
import asyncio
from concurrent.futures import ThreadPoolExecutor
from time import monotonic

import httpx2

from homun.models.native_errors import NativeModelError, CANCELLED, TIMEOUT, classify_transport
from homun.models.native_stream import NativeStream

POLL_SECONDS = 0.05


def stream_response(provider, payload, *, api_key, ollama, cancel_check=None, on_delta=None, usage_factory):
    parser = NativeStream(ollama=ollama, on_delta=on_delta)
    url = (provider._ollama_native_root() + '/api/chat' if ollama else provider.base_url + '/chat/completions')
    async def consume():
        async with httpx2.AsyncClient(timeout=provider.timeout_seconds, follow_redirects=False) as client:
            async with client.stream('POST', url, json=payload, headers={
                'Authorization':f'Bearer {api_key}', 'Accept-Encoding':'identity', 'Accept':'application/x-ndjson' if ollama else 'text/event-stream'
            }) as response:
                response.raise_for_status()
                if response.headers.get('Content-Encoding', 'identity').lower() != 'identity':
                    parser.fail('Compressed native streams are unsupported')
                async for data in response.aiter_raw(chunk_size=None):
                    parser.feed(data)
                    if parser.terminal: break
        return parser.finish()

    async def supervise():
        if cancel_check and cancel_check(): raise NativeModelError(CANCELLED, retryable=False)
        task = asyncio.create_task(consume())
        deadline = monotonic() + provider.timeout_seconds
        try:
            while True:
                if cancel_check and cancel_check(): raise NativeModelError(CANCELLED, retryable=False)
                if monotonic() >= deadline: raise NativeModelError(TIMEOUT, retryable=False)
                done, _ = await asyncio.wait({task}, timeout=POLL_SECONDS)
                if done:
                    if cancel_check and cancel_check(): raise NativeModelError(CANCELLED, retryable=False)
                    return task.result()
        finally:
            if not task.done(): task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    try:
        try: asyncio.get_running_loop()
        except RuntimeError: return asyncio.run(supervise())
        # Sync model ports can also be used from an async host. The worker is
        # joined and all HTTP tasks closed before this call returns.
        with ThreadPoolExecutor(max_workers=1, thread_name_prefix='native-stream') as executor:
            return executor.submit(lambda: asyncio.run(supervise())).result()
    except Exception as exc:
        if isinstance(exc, NativeModelError): error = exc
        else:
            if isinstance(exc, httpx2.HTTPStatusError):
                exc.status_code = exc.response.status_code
                exc.headers = exc.response.headers
            error = classify_transport(exc)
            # A stream is never replayed automatically after possibly consuming output.
            error.retryable = False
        error.usage = usage_factory(parser.usage_response()).model_copy(update={
            'status':'error', 'error_code':error.code})
        raise error from (exc if error is not exc else None)
