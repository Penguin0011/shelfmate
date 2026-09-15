import asyncio
import json
import logging
import time
from threading import BoundedSemaphore
import httpx
from django.conf import settings
from .validation import Invalid

logger = logging.getLogger(__name__)
slots = BoundedSemaphore(2)

class AIError(Exception):
    pass

class Retryable(AIError):
    pass


async def request(provider, key, model, url, messages):
    if not key:
        raise AIError(f'{provider} API key is not configured')
    payload = {'model': model, 'messages': messages, 'max_tokens': 4096, 'temperature': 0.1}
    try:
        async with asyncio.timeout(30):
            async with httpx.AsyncClient(timeout=25) as client:
                async with client.stream('POST', url, json=payload, headers={'Authorization': f'Bearer {key}'}) as response:
                    if response.status_code == 429 or response.status_code >= 500:
                        raise Retryable('AI service temporarily unavailable')
                    if response.status_code in (401, 403):
                        raise AIError(f'{provider} authentication or access failed')
                    if response.status_code != 200:
                        raise AIError(f'{provider} rejected the request')
                    raw = bytearray()
                    async for chunk in response.aiter_bytes():
                        raw.extend(chunk)
                        if len(raw) > 1_000_000:
                            raise Retryable('AI response too large')
        result = json.loads(raw)
        choice = result['choices'][0]
        message = choice['message']
        if message.get('refusal') or choice.get('finish_reason') == 'content_filter':
            raise AIError('AI declined this request')
        if choice.get('finish_reason') == 'length':
            raise Retryable('AI response incomplete')
        text = message['content']
        if not isinstance(text, str):
            raise Retryable('Invalid AI content')
        # Accept only a single JSON value, optionally inside a JSON code fence.
        text = text.strip()
        if text.startswith('```json\n') and text.endswith('```'):
            text = text[8:-3].strip()
        return json.loads(text), result.get('model', model)
    except (TimeoutError, httpx.RequestError) as exc:
        raise Retryable('AI request timed out or disconnected') from exc
    except (ValueError, KeyError, IndexError, TypeError) as exc:
        raise Retryable('Invalid AI response') from exc


async def _run(messages, validate):
    providers = [
        ('NVIDIA', settings.NVIDIA_API_KEY, 'nvidia/nemotron-nano-12b-v2-vl', 'https://integrate.api.nvidia.com/v1/chat/completions'),
        ('OpenRouter', settings.OPENROUTER_API_KEY, 'openrouter/free', 'https://openrouter.ai/api/v1/chat/completions'),
    ]
    for name, key, model, url in providers:
        started = time.monotonic()
        try:
            result, actual_model = await request(name, key, model, url, messages)
            validated = validate(result)
            logger.info('AI provider=%s model=%s duration=%.2f status=ok', name, str(actual_model)[:150], time.monotonic()-started)
            return validated
        except (Retryable, Invalid):
            logger.warning('AI provider=%s duration=%.2f status=retryable', name, time.monotonic()-started)
    raise AIError('AI unavailable; retry later or enter items manually')


async def bounded(messages, validate):
    try:
        async with asyncio.timeout(60):
            return await _run(messages, validate)
    except TimeoutError as exc:
        raise AIError('AI deadline exceeded; retry later') from exc


def complete(messages, validate):
    # ponytail: one process, two remote calls at once; add a queue only if needed.
    if not slots.acquire(blocking=False):
        raise AIError('AI is busy; try again shortly')
    try:
        return asyncio.run(bounded(messages, validate))
    finally:
        slots.release()
