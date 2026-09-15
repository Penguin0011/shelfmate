from django.core.management.base import BaseCommand
from inventory.drafts import cleanup
class Command(BaseCommand):
    help = 'Expire photo drafts and retry private file cleanup'
    def handle(self, **options):
        self.stdout.write(f'Cleaned {cleanup()} closed drafts')
