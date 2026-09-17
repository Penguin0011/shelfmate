import uuid
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
    existing = {name.strip().casefold() for name in draft.box.items.values_list('name', flat=True)} if draft.box_id else set()
    return {'id': str(draft.pk), 'box': draft.box.number if draft.box_id else None, 'state': draft.state, 'revision': draft.revision, 'entries': draft.entries, 'receipt': draft.receipt, 'transcript': draft.transcript, 'context': draft.context, 'expires_at': draft.expires_at, 'photos': [f'/api/drafts/{draft.pk}/photos/{n}/' for n in range(len(draft.files))] if draft.state == 'open' and draft.expires_at > timezone.now() else [], 'duplicates': [n for n, row in enumerate(draft.entries) if row['name'].strip().casefold() in existing],
            # A boolean, not the timestamp: the client only needs to know a run is in flight, and
            # comparing a server deadline against a browser clock would skew the answer.
            'analyzing': bool(draft.analyzing_until and draft.analyzing_until > timezone.now())}


@endpoint(['POST'], owner=True)
def create(request, number=None):
    # No number means a quick snap from the home screen: recognition starts now, the box is chosen
    # while it runs. save() refuses a draft that never got one.
    box = get_object_or_404(Box, number=number, retired=False) if number is not None else None
    upload_id = request.POST.get('upload_id')
    if upload_id is not None:
        try:
            upload_id = uuid.UUID(upload_id)
        except (ValueError, AttributeError):
            raise Invalid('Invalid upload ID')
        existing = Draft.objects.filter(pk=upload_id).first()
        if existing:
            # Retry after a lost response returns the same receipt, never a duplicate draft.
            return JsonResponse(data(get_object_or_404(Draft, pk=upload_id, owner=request.user)))
    draft = drafts.upload(request.user, box, request.FILES.getlist('photos'), string(request.POST, 'transcript', 5000), string(request.POST, 'context', 1000), draft_id=upload_id)
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
def meta(request, pk):
    # The fields the owner may change *while recognition is running*: which box it gets filed in and
    # the note that steers the model. Both are written with .update(), which leaves revision alone --
    # the analysis writes its result under the revision its run began with, so a bump here would make
    # that write match nothing and the recognition would be discarded. See handoff.md's invariants.
    draft = owned(request, pk)
    drafts.open_draft(draft)
    payload = body(request)
    fields = {}
    if 'box' in payload:
        fields['box'] = get_object_or_404(Box, number=integer(payload, 'box'), retired=False)
    if 'context' in payload:
        fields['context'] = string(payload, 'context', 1000)
    if not fields:
        raise Invalid('Nothing to change')
    Draft.objects.filter(pk=draft.pk, owner=request.user, state='open').update(**fields)
    draft.refresh_from_db()
    # Full draft back, not just the changed field: filing into a different box changes which entries
    # count as duplicates, and the caller has no other way to learn that.
    return JsonResponse(data(draft))


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
