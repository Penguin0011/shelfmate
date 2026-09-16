from itertools import groupby

from django.shortcuts import render, get_object_or_404, redirect
from django.db.models import Count, Max
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
    last_change = Box.objects.order_by('-updated_at').values_list('updated_at', flat=True).first() if screen == 'home' and number is None and draft_id is None else None
    # The index groups boxes under their location; blank locations sort last under one heading.
    ordered = sorted(boxes, key=lambda b: (b.location.casefold() or '￿', b.number))
    groups = [{'location': rows[0].location or 'Unplaced', 'boxes': rows}
              for rows in (list(g) for _, g in groupby(ordered, key=lambda b: b.location.casefold()))]
    box = get_object_or_404(Box, number=number) if number is not None else None
    draft = get_object_or_404(Draft, pk=draft_id, owner=request.user) if draft_id else None
    if draft:
        box, screen = draft.box, 'draft'
    elif box:
        screen = 'box'
    flags = Flag.objects.select_related('box').order_by('-created_at') if owner else Flag.objects.none()
    items = list(box.items.select_related('box')) if box else []
    # Prefill the new-box number. Deliberately max+1 over *every* box including retired ones:
    # box_create treats an existing retired number as a restore, so suggesting a reused number
    # would silently revive an archived box -- and hand out an NFC tag already stuck to a real one.
    next_number = (Box.objects.aggregate(highest=Max('number'))['highest'] or 0) + 1 if owner else None
    bootstrap = {'owner': bool(owner), 'next_number': next_number,
                 'locations': sorted({b.location for b in boxes if b.location}, key=str.casefold) if owner else [],
                 'boxes': [{'number': b.number, 'category': b.category, 'location': b.location} for b in boxes],
                 'box': {'number': box.number, 'category': box.category, 'location': box.location, 'revision': box.revision, 'retired': box.retired} if box else None,
                 'items': [item_data(i) for i in items], 'draft': draft_data(draft) if draft else None}
    return render(request, 'inventory/page.html', {
        'screen': screen, 'owner': owner, 'boxes': boxes, 'groups': groups, 'box': box, 'items': items,
        'archived_boxes': Box.objects.filter(retired=True) if owner else [],
        'total': sum(b.count for b in boxes), 'last_change': last_change,
        'open_count': flags.filter(status='open').count(),
        'open_flags': flags.filter(status='open') if screen == 'inbox' else [],
        'history': flags.exclude(status='open') if screen == 'inbox' else [],
        'bootstrap': bootstrap,
    })
