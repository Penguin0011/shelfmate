import uuid
from datetime import timedelta
from django.conf import settings
from django.db import models
from django.utils import timezone


def expiry():
    return timezone.now() + timedelta(hours=24)


class Box(models.Model):
    number = models.PositiveIntegerField(unique=True)
    category = models.CharField(max_length=120)
    location = models.CharField(max_length=120, blank=True, default="")
    retired = models.BooleanField(default=False)
    revision = models.PositiveIntegerField(default=0)
    updated_at = models.DateTimeField(auto_now=True)
    class Meta:
        ordering = ['number']
        constraints = [models.CheckConstraint(condition=models.Q(number__gt=0), name='positive_box_number')]


def touch_boxes(*ids):
    Box.objects.filter(pk__in=ids).update(updated_at=timezone.now())


class Draft(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    owner = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    # Null until the owner picks one: a quick snap from the home screen starts recognition
    # first and asks which box it belongs in while the model is still reading the photo.
    box = models.ForeignKey(Box, on_delete=models.PROTECT, null=True)
    state = models.CharField(max_length=16, default='open')
    entries = models.JSONField(default=list)
    files = models.JSONField(default=list)
    transcript = models.CharField(max_length=5000, blank=True, default="")
    # What the owner told us about the material, to steer recognition. Kept apart from transcript:
    # a transcript is a source of items, this is guidance about them and must never become one.
    context = models.CharField(max_length=1000, blank=True, default="")
    receipt = models.JSONField(default=list)
    revision = models.PositiveIntegerField(default=0)
    created_at = models.DateTimeField(auto_now_add=True)
    expires_at = models.DateTimeField(default=expiry)
    analyzing_until = models.DateTimeField(null=True)
    analysis_token = models.UUIDField(null=True)


class Item(models.Model):
    box = models.ForeignKey(Box, on_delete=models.PROTECT, related_name='items')
    name = models.CharField(max_length=200)
    description = models.CharField(max_length=2000, blank=True)
    aliases = models.CharField(max_length=1000, blank=True)
    revision = models.PositiveIntegerField(default=0)
    draft = models.ForeignKey(Draft, null=True, on_delete=models.PROTECT)
    draft_row = models.PositiveIntegerField(null=True)
    class Meta:
        ordering = ['name', 'pk']
        constraints = [models.UniqueConstraint(fields=['draft', 'draft_row'], name='unique_batch_row')]


class Flag(models.Model):
    box = models.ForeignKey(Box, on_delete=models.PROTECT)
    item = models.ForeignKey(Item, null=True, on_delete=models.SET_NULL)
    item_name = models.CharField(max_length=200, blank=True)
    reason = models.CharField(max_length=30)
    note = models.CharField(max_length=2000, blank=True)
    reporter = models.CharField(max_length=100, blank=True)
    status = models.CharField(max_length=12, default='open')
    created_at = models.DateTimeField(auto_now_add=True)
    resolved_at = models.DateTimeField(null=True)
