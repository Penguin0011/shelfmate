import os
import sqlite3
from pathlib import Path
from django.conf import settings
from django.core.management.base import BaseCommand, CommandError

class Command(BaseCommand):
    help = 'Create a consistent SQLite backup without temporary draft payloads or sessions'
    def add_arguments(self, parser):
        parser.add_argument('destination')
    def handle(self, destination, **options):
        target=Path(destination).resolve()
        source=Path(settings.DATABASES['default']['NAME']).resolve()
        if target==source or not source.exists():
            raise CommandError('Choose a new backup destination and an existing database')
        try:
            fd=os.open(target,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
            os.close(fd)
        except OSError as exc:
            raise CommandError('Cannot create backup; destination must not exist') from exc
        try:
            with sqlite3.connect(f'{source.as_uri()}?mode=ro',uri=True) as src, sqlite3.connect(target) as dest:
                src.backup(dest)
                dest.execute("UPDATE inventory_draft SET entries='[]', files='[]', transcript='', context='', state=CASE WHEN state='open' THEN 'expired' ELSE state END, analyzing_until=NULL, analysis_token=NULL")
                dest.execute('DELETE FROM django_session')
                dest.commit()
                dest.execute('VACUUM')
                if dest.execute('PRAGMA integrity_check').fetchone()[0]!='ok' or dest.execute('PRAGMA foreign_key_check').fetchall():
                    raise CommandError('Backup integrity check failed')
        except BaseException:
            target.unlink(missing_ok=True)
            raise
        self.stdout.write('Backup created and integrity checked')
