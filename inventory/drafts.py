import io
import shutil
import uuid
import warnings
from pathlib import Path
from django.conf import settings
from django.db import transaction
from django.utils import timezone
from PIL import Image, ImageOps, UnidentifiedImageError
from .models import Draft, Item, touch_boxes
from .validation import Invalid, entries

# Optional so the app still boots if the wheel is not installed yet; a deploy that copies code
# before pip runs would otherwise crash on import. Phones shoot HEIC by default.
try:
    from pillow_heif import register_heif_opener
    register_heif_opener()
    ACCEPTED = ('JPEG', 'PNG', 'HEIF')
except ImportError:
    ACCEPTED = ('JPEG', 'PNG')

# A 48MP iPhone frame is 48.8M pixels, so the old 25M cap rejected every full-resolution phone
# photo regardless of format. 60M clears current phones; at 3 bytes/pixel that is ~180 MB per
# decode, which the VM's memory tolerates across gunicorn's four threads.
Image.MAX_IMAGE_PIXELS = 60_000_000


def directory(draft):
    return Path(settings.PHOTO_ROOT) / str(draft.pk)


def cleanup_files(draft):
    try:
        shutil.rmtree(directory(draft))
    except FileNotFoundError:
        pass
    except OSError:
        return False
    Draft.objects.filter(pk=draft.pk).update(files=[])
    return True


def upload(owner, box, photos, transcript='', context=''):
    if not photos and not transcript:
        raise Invalid('Add photos or a spoken description')
    if len(photos) > 4 or sum(p.size for p in photos) > 25 * 1024 * 1024:
        raise Invalid('Upload at most 4 photos, 25 MB total')
    draft = Draft(owner=owner, box=box, transcript=transcript, context=context)
    folder = directory(draft)
    folder.mkdir(mode=0o700, parents=True)
    normalized = 0
    try:
        for photo in photos:
            if photo.size > 10 * 1024 * 1024:
                raise Invalid('Each photo must be at most 10 MB')
            try:
                with warnings.catch_warnings():
                    warnings.simplefilter('error', Image.DecompressionBombWarning)
                    with Image.open(photo) as source:
                        if source.format not in ACCEPTED:
                            raise Invalid(f'{source.format or "That file"} is not a supported image; upload JPEG or PNG')
                        source.load()
                        converted = ImageOps.exif_transpose(source).convert('RGB')
                        if min(converted.size) < 32:
                            raise Invalid('Image must be at least 32 pixels on each side')
                        converted.thumbnail((1536, 1536))
                        # A fresh image excludes EXIF, comments, and other source metadata.
                        clean = Image.new('RGB', converted.size)
                        clean.paste(converted)
                        out = io.BytesIO()
                        clean.save(out, format='JPEG', quality=85)
                payload = out.getvalue()
            # Invalid subclasses ValueError, so it must be re-raised before the sweep below or every
            # specific reason above collapses into one message that misdiagnoses the upload.
            except Invalid:
                raise
            except (Image.DecompressionBombError, Image.DecompressionBombWarning):
                raise Invalid(f'Photo is larger than {Image.MAX_IMAGE_PIXELS // 1_000_000} megapixels; upload a smaller copy')
            except UnidentifiedImageError:
                raise Invalid('That file could not be read as an image' + ('' if 'HEIF' in ACCEPTED else '; export HEIC as JPEG first'))
            except (OSError, ValueError):
                raise Invalid('That image could not be processed; it may be incomplete or damaged')
            normalized += len(payload)
            if normalized > 8 * 1024 * 1024:
                raise Invalid('Normalized images exceed 8 MB; use fewer photos')
            filename = f'{uuid.uuid4().hex}.jpg'
            (folder / filename).write_bytes(payload)
            (folder / filename).chmod(0o600)
            draft.files.append(filename)
        draft.save()
        return draft
    except BaseException:
        shutil.rmtree(folder, ignore_errors=True)
        raise
    finally:
        for photo in photos:
            photo.close()


def open_draft(draft):
    if draft.state != 'open' or draft.expires_at <= timezone.now():
        raise Invalid('Draft is closed or expired')


def update(draft_id, owner, revision, proposed):
    proposed = entries(proposed)
    with transaction.atomic():
        draft = Draft.objects.get(pk=draft_id, owner=owner)
        open_draft(draft)
        if revision != draft.revision:
            raise Invalid('Draft changed; reload before editing')
        draft.entries = proposed
        draft.revision += 1
        draft.analysis_token = None
        draft.analyzing_until = None
        draft.save()
    return draft


def save(draft_id, owner, revision):
    with transaction.atomic():
        draft = Draft.objects.select_related('box').get(pk=draft_id, owner=owner)
        if draft.state == 'saved':
            return draft.receipt
        open_draft(draft)
        if revision != draft.revision:
            raise Invalid('Draft changed; reload before saving')
        if draft.box.retired:
            raise Invalid('Box is retired')
        proposed = entries(draft.entries)
        if not proposed:
            raise Invalid('Add at least one item before saving')
        draft.receipt = [Item.objects.create(box=draft.box, draft=draft, draft_row=n, **row).pk for n, row in enumerate(proposed)]
        touch_boxes(draft.box_id)
        draft.state = 'saved'
        draft.entries = []
        draft.analysis_token = None
        draft.analyzing_until = None
        draft.revision += 1
        draft.save()
        transaction.on_commit(lambda: cleanup_files(draft))
    return draft.receipt


def cancel(draft_id, owner):
    with transaction.atomic():
        draft = Draft.objects.get(pk=draft_id, owner=owner)
        if draft.state == 'saved':
            raise Invalid('Already saved; edit inventory instead')
        draft.state, draft.entries = 'cancelled', []
        draft.analysis_token = None
        draft.analyzing_until = None
        draft.revision += 1
        draft.save()
        transaction.on_commit(lambda: cleanup_files(draft))


def cleanup():
    now = timezone.now()
    Draft.objects.filter(state='open', expires_at__lte=now).update(state='expired', entries=[], analysis_token=None, analyzing_until=None)
    count = 0
    for draft in Draft.objects.exclude(state='open'):
        count += cleanup_files(draft)
    root = Path(settings.PHOTO_ROOT)
    if root.exists():
        known = set(str(pk) for pk in Draft.objects.values_list('pk', flat=True))
        for path in root.iterdir():
            if path.is_dir() and path.name not in known and path.stat().st_mtime < now.timestamp() - 86400:
                shutil.rmtree(path)
    return count
