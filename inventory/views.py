from django.contrib.auth import authenticate, login, logout
from django.db import transaction, IntegrityError
from django.db.models import Q, F
from django.http import JsonResponse
from django.shortcuts import get_object_or_404
from django.middleware.csrf import get_token
from django.utils import timezone
from .access import endpoint, body, limited
from .models import Box, Item, Flag
from .validation import Invalid, integer, string, entries


def item_data(item):
    return {'id': item.pk, 'name': item.name, 'description': item.description, 'aliases': item.aliases, 'revision': item.revision, 'box': item.box.number, 'category': item.box.category}


@endpoint(['GET'])
def session(request):
    return JsonResponse({'csrfToken': get_token(request), 'owner': bool(request.user.is_authenticated and request.user.is_staff)})


@endpoint(['POST'])
def sign_in(request):
    if limited(request, 'login', 10):
        return JsonResponse({'error': 'Try again later'}, status=429)
    data = body(request)
    password = data.get('password')
    if not isinstance(password, str) or not 1 <= len(password) <= 1024:
        raise Invalid('Invalid password')
    user = authenticate(request, username=string(data, 'username', 150, True), password=password)
    if not user or not user.is_active or not user.is_staff:
        return JsonResponse({'error': 'Invalid owner credentials'}, status=403)
    login(request, user)
    return JsonResponse({'csrfToken': get_token(request), 'owner': True})


@endpoint(['POST'])
def sign_out(request):
    logout(request)
    return JsonResponse({'ok': True})


@endpoint(['GET'])
def health(request):
    return JsonResponse({'ok': True})


@endpoint(['GET'])
def boxes(request):
    return JsonResponse({'boxes': list(Box.objects.filter(retired=False).values('number', 'category', 'revision'))})


@endpoint(['GET'])
def box_detail(request, number):
    box = get_object_or_404(Box, number=number)
    return JsonResponse({'number': box.number, 'category': box.category, 'retired': box.retired, 'revision': box.revision, 'items': [item_data(i) for i in box.items.select_related('box')]})


@endpoint(['GET'])
def search(request):
    query = request.GET.get('q', '').strip()
    if len(query) > 500:
        raise Invalid('Search is too long')
    found = Item.objects.filter(box__retired=False).select_related('box')
    if query:
        found = found.filter(Q(name__icontains=query) | Q(description__icontains=query) | Q(aliases__icontains=query))
    return JsonResponse({'items': [item_data(i) for i in found]})


@endpoint(['POST'], owner=True)
def box_create(request):
    data = body(request)
    number = integer(data, 'number')
    if not 0 < number <= 2147483647:
        raise Invalid('Number must be positive')
    try:
        box = Box.objects.create(number=number, category=string(data, 'category', 120, True))
    except IntegrityError:
        return JsonResponse({'error': 'Box number already used'}, status=409)
    return JsonResponse({'number': box.number}, status=201)


@endpoint(['POST'], owner=True)
def box_edit(request, number):
    data = body(request)
    with transaction.atomic():
        box = get_object_or_404(Box, number=number)
        if integer(data, 'revision') != box.revision:
            return JsonResponse({'error': 'Box changed; reload'}, status=409)
        retired = data.get('retired', box.retired)
        if type(retired) is not bool:
            raise Invalid('Invalid retired value')
        if retired and box.items.exists():
            raise Invalid('Move or remove contents before retirement')
        box.category = string(data, 'category', 120, True)
        box.retired = retired
        box.revision += 1
        box.save()
    return JsonResponse({'revision': box.revision})


@endpoint(['POST'], owner=True)
def item_create(request):
    data = body(request)
    fields = entries([data])[0]
    with transaction.atomic():
        box = get_object_or_404(Box, number=integer(data, 'box'), retired=False)
        item = Item.objects.create(box=box, **fields)
    return JsonResponse(item_data(item), status=201)


@endpoint(['POST'], owner=True)
def item_edit(request, pk):
    data = body(request)
    with transaction.atomic():
        item = get_object_or_404(Item.objects.select_related('box'), pk=pk)
        if integer(data, 'revision') != item.revision:
            return JsonResponse({'error': 'Item changed; reload'}, status=409)
        if data.get('delete') is True:
            item.delete()
            return JsonResponse({'ok': True})
        item.box = get_object_or_404(Box, number=integer(data, 'box'), retired=False)
        for key, value in entries([data])[0].items():
            setattr(item, key, value)
        item.revision += 1
        item.save()
    return JsonResponse(item_data(item))


@endpoint(['POST'])
def flag_create(request, number):
    if limited(request, 'flag', 20):
        return JsonResponse({'error': 'Try again later'}, status=429)
    data = body(request)
    reason = string(data, 'reason', 30, True)
    if reason not in ['missing', 'taken', 'moved', 'other']:
        raise Invalid('Invalid flag reason')
    with transaction.atomic():
        box = get_object_or_404(Box, number=number)
        item = get_object_or_404(Item, pk=integer(data, 'item'), box=box) if data.get('item') is not None else None
        flag = Flag.objects.create(box=box, item=item, item_name=item.name if item else '', reason=reason, note=string(data, 'note', 2000), reporter=string(data, 'reporter', 100))
    return JsonResponse({'id': flag.pk}, status=201)


@endpoint(['GET'], owner=True)
def flags(request):
    return JsonResponse({'unresolved': Flag.objects.filter(status='open').count(), 'flags': list(Flag.objects.order_by('-created_at').values('id', 'box__number', 'item_id', 'item_name', 'reason', 'note', 'reporter', 'status', 'created_at', 'resolved_at'))})


@endpoint(['POST'], owner=True)
def flag_edit(request, pk):
    data = body(request)
    status = data.get('status')
    if status not in ['resolved', 'dismissed']:
        raise Invalid('Invalid status')
    flag = get_object_or_404(Flag, pk=pk)
    flag.status, flag.resolved_at = status, timezone.now()
    flag.save(update_fields=['status', 'resolved_at'])
    return JsonResponse({'ok': True})
