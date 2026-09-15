import json
import time
from collections import OrderedDict
from functools import wraps
from threading import Lock
from django.http import JsonResponse
from django.core.exceptions import RequestDataTooBig
from .validation import Invalid

lock = Lock()
buckets = OrderedDict()


def limited(request, action, limit):
    # ponytail: bounded single-process throttle; shared storage if adding workers.
    key = (action, request.META.get('REMOTE_ADDR', 'unknown'))
    now = time.monotonic()
    with lock:
        start, count = buckets.pop(key, (now, 0))
        if now - start >= 60:
            start, count = now, 0
        buckets[key] = (start, count + 1)
        while len(buckets) > 4096:
            buckets.popitem(last=False)
        return count >= limit


def endpoint(methods, owner=False):
    def decorate(fn):
        @wraps(fn)
        def wrapped(request, *args, **kwargs):
            if request.method not in methods:
                return JsonResponse({'error': 'Method not allowed'}, status=405)
            if owner and not (request.user.is_authenticated and request.user.is_active and request.user.is_staff):
                return JsonResponse({'error': 'Owner access required'}, status=403)
            try:
                return fn(request, *args, **kwargs)
            except (Invalid, RequestDataTooBig) as exc:
                return JsonResponse({'error': str(exc)}, status=400)
        return wrapped
    return decorate


def body(request):
    try:
        value = json.loads(request.body)
    except (ValueError, UnicodeDecodeError):
        raise Invalid('Expected JSON object')
    if not isinstance(value, dict):
        raise Invalid('Expected JSON object')
    return value
