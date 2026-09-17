import json
import logging
import time
from threading import BoundedSemaphore
import httpx
from django.conf import settings
from .validation import Invalid, entries

logger = logging.getLogger(__name__)
slots = BoundedSemaphore(2)

class AIError(Exception):
    pass

class Retryable(AIError):
    pass


class Refused(AIError):
    # A content refusal, as opposed to a provider failing us. Kept distinct because it must NOT
    # fall through to the next provider: the others would likely refuse the same input, and trying
    # each in turn amounts to shopping for a compliant model.
    pass


def request(provider, key, model, url, messages, timeout=None, extra=None):
    if not key:
        raise AIError(f'{provider} API key is not configured')
    # extra is per-provider: a parameter one provider understands is a 400 from the next one.
    payload = {'model': model, 'messages': messages, 'max_tokens': settings.AI_MAX_TOKENS, 'temperature': 0.1, **(extra or {})}
    budget = timeout or settings.AI_PROVIDER_TIMEOUT + 15
    deadline = time.monotonic() + budget
    # Connecting should be quick; uploading photos and waiting for generation should not be rushed.
    limits = httpx.Timeout(connect=min(10, budget), read=budget, write=budget, pool=min(10, budget))
    try:
        with httpx.Client(timeout=limits) as client:
            with client.stream('POST', url, json=payload, headers={'Authorization': f'Bearer {key}'}) as response:
                if response.status_code in (410, 429) or response.status_code >= 500:
                    raise Retryable('AI service temporarily unavailable')
                if response.status_code in (401, 403):
                    raise AIError(f'{provider} authentication or access failed')
                if response.status_code != 200:
                    raise AIError(f'{provider} rejected the request')
                raw = bytearray()
                for chunk in response.iter_bytes():
                    raw.extend(chunk)
                    if time.monotonic() >= deadline:
                        raise Retryable('AI request timed out or disconnected')
                    if len(raw) > 1_000_000:
                        raise Retryable('AI response too large')
        result = json.loads(raw)
        choice = result['choices'][0]
        message = choice['message']
        if message.get('refusal') or choice.get('finish_reason') == 'content_filter':
            raise Refused('AI declined this request')
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


def _run(messages, validate, fireworks_model=None, fireworks_extra=None):
    # Most reliable first, then fastest; a slow provider must never starve the ones behind it.
    # Only the Fireworks row is task-tunable: the failovers are general-purpose, and a model name
    # or a reasoning_effort meant for Fireworks is a 400 from any of them.
    providers = [
        ('Fireworks', settings.FIREWORKS_API_KEY, fireworks_model or settings.FIREWORKS_MODEL, 'https://api.fireworks.ai/inference/v1/chat/completions', settings.FIREWORKS_EXTRA if fireworks_extra is None else fireworks_extra),
        ('Gemini', settings.GEMINI_API_KEY, settings.GEMINI_MODEL, 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', None),
        ('OpenRouter', settings.OPENROUTER_API_KEY, settings.OPENROUTER_MODEL, 'https://openrouter.ai/api/v1/chat/completions', None),
    ]
    deadline = time.monotonic() + settings.AI_TOTAL_TIMEOUT
    for name, key, model, url, extra in providers:
        # Skip unconfigured providers here: request() raises AIError for a missing key, and AIError
        # is deliberately not retryable, so letting it through would abort the whole chain instead
        # of falling through to the providers that *are* configured.
        if not key:
            logger.info('AI provider=%s status=skipped reason=no key configured', name)
            continue
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        started = time.monotonic()
        try:
            result, actual_model = request(name, key, model, url, messages, timeout=min(settings.AI_PROVIDER_TIMEOUT + 15, remaining), extra=extra)
            if time.monotonic() >= deadline:
                break
            validated = validate(result)
            logger.info('AI provider=%s model=%s duration=%.2f status=ok', name, str(actual_model)[:150], time.monotonic()-started)
            return validated
        except Refused:
            raise
        except (Retryable, Invalid) as exc:
            # Record why, or the next outage costs a debugging session to reach this same line.
            logger.warning('AI provider=%s duration=%.2f status=retryable reason=%s: %s', name, time.monotonic()-started, type(exc).__name__, exc)
        except AIError as exc:
            # A provider rejecting us -- bad parameters, a stale key, a model retired out from under
            # us -- says nothing about the providers behind it, so carry on down the chain instead
            # of failing the whole request. gemini-2.5-flash returning 404 'no longer available to
            # new users' is exactly this case.
            logger.warning('AI provider=%s duration=%.2f status=rejected reason=%s: %s', name, time.monotonic()-started, type(exc).__name__, exc)
    if time.monotonic() >= deadline:
        raise AIError('AI deadline exceeded; retry later')
    raise AIError('AI unavailable; retry later or enter items manually')


def complete(messages, validate, fireworks_model=None, fireworks_extra=None):
    # The two Fireworks tasks want different models: photo recognition pays for vision that works,
    # search pays for a cheap cached-input rate on an inventory it re-sends every question. The
    # model and its parameters travel together -- reasoning_effort is tuned per model, not per task.
    # ponytail: one process, two remote calls at once; add a queue only if needed.
    if not slots.acquire(blocking=False):
        raise AIError('AI is busy; try again shortly')
    try:
        return _run(messages, validate, fireworks_model, fireworks_extra)
    finally:
        slots.release()


def suggestions(value):
    # Some routed models return aliases as a list despite the requested string.
    if isinstance(value, list):
        normalized = []
        for row in value:
            if isinstance(row, dict) and isinstance(row.get('aliases'), list):
                aliases = row['aliases']
                if len(aliases) > 20 or any(not isinstance(a, str) or len(a) > 200 for a in aliases):
                    raise Invalid('Invalid aliases')
                row = {**row, 'aliases': ', '.join(aliases)}
            normalized.append(row)
        value = normalized
    return entries(value)
