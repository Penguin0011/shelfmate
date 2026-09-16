from django.http import JsonResponse, FileResponse
from django.shortcuts import get_object_or_404
from django.utils import timezone
from .access import endpoint, body
from .models import Draft, Box
from .validation import integer, string, Invalid
from . import drafts


def owned(request, pk):
    return get_object_or_404(Draft, pk=pk, owner=request.user)


def data(draft):
    existing = {name.strip().casefold() for name in draft.box.items.values_list('name', flat=True)}
    return {'id': str(draft.pk), 'box': draft.box.number, 'state': draft.state, 'revision': draft.revision, 'entries': draft.entries, 'receipt': draft.receipt, 'transcript': draft.transcript, 'expires_at': draft.expires_at, 'photos': [f'/api/drafts/{draft.pk}/photos/{n}/' for n in range(len(draft.files))] if draft.state == 'open' and draft.expires_at > timezone.now() else [], 'duplicates': [n for n, row in enumerate(draft.entries) if row['name'].strip().casefold() in existing]}


@endpoint(['POST'], owner=True)
def create(request, number):
    box = get_object_or_404(Box, number=number, retired=False)
    draft = drafts.upload(request.user, box, request.FILES.getlist('photos'), string(request.POST, 'transcript', 5000))
    return JsonResponse(data(draft), status=201)


@endpoint(['GET', 'POST'], owner=True)
def detail(request, pk):
    draft = owned(request, pk)
    if request.method == 'POST':
        payload = body(request)
        draft = drafts.update(draft.pk, request.user, integer(payload, 'revision'), payload.get('entries'))
    return JsonResponse(data(draft))


@endpoint(['GET'], owner=True)
def listing(request):
    return JsonResponse({'drafts': [data(d) for d in Draft.objects.filter(owner=request.user, state='open', expires_at__gt=timezone.now()).select_related('box')]})


@endpoint(['POST'], owner=True)
def save(request, pk):
    draft = owned(request, pk)
    return JsonResponse({'items': drafts.save(draft.pk, request.user, integer(body(request), 'revision'))})


@endpoint(['POST'], owner=True)
def cancel(request, pk):
    draft = owned(request, pk)
    drafts.cancel(draft.pk, request.user)
    return JsonResponse({'ok': True})


@endpoint(['GET'], owner=True)
def photo(request, pk, index):
    draft = owned(request, pk)
    drafts.open_draft(draft)
    if index >= len(draft.files):
        raise Invalid('No such photo')
    try:
        response = FileResponse((drafts.directory(draft) / draft.files[index]).open('rb'), content_type='image/jpeg')
    except FileNotFoundError:
        raise Invalid('Photo unavailable')
    response['Cache-Control'] = 'no-store, private'
    return response
