from django.shortcuts import render, get_object_or_404, redirect
from django.db.models import Count
from django.views.decorators.cache import never_cache
from .models import Box, Draft, Flag
from .views import item_data
from .draft_views import data as draft_data


@never_cache
def page(request, number=None, draft_id=None, screen='home'):
    owner = request.user.is_authenticated and request.user.is_active and request.user.is_staff
    if (screen in ('inbox', 'draft') or draft_id) and not owner:
        return redirect('/?login=1')
    boxes = list(Box.objects.filter(retired=False).annotate(count=Count('items')).order_by('number'))
    box = get_object_or_404(Box, number=number) if number is not None else None
    draft = get_object_or_404(Draft, pk=draft_id, owner=request.user) if draft_id else None
    if draft:
        box, screen = draft.box, 'draft'
    elif box:
        screen = 'box'
    flags = Flag.objects.select_related('box').order_by('-created_at') if owner else Flag.objects.none()
    items = list(box.items.select_related('box')) if box else []
    bootstrap = {'owner': bool(owner), 'screen': screen,
                 'boxes': [{'number': b.number, 'category': b.category} for b in boxes],
                 'box': {'number': box.number, 'category': box.category, 'revision': box.revision, 'retired': box.retired} if box else None,
                 'items': [item_data(i) for i in items], 'draft': draft_data(draft) if draft else None}
    return render(request, 'inventory/page.html', {
        'screen': screen, 'owner': owner, 'boxes': boxes, 'box': box, 'items': items,
        'total': sum(b.count for b in boxes), 'open_count': flags.filter(status='open').count(),
        'open_flags': flags.filter(status='open') if screen == 'inbox' else [],
        'history': flags.exclude(status='open') if screen == 'inbox' else [],
        'bootstrap': bootstrap,
    })
