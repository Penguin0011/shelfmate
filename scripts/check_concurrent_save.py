"""Run with the project Python: two processes save one draft to a real SQLite file."""
import os
import sqlite3
import subprocess
import sys
import tempfile
import time
from pathlib import Path

os.chdir(Path(__file__).resolve().parents[1])
with tempfile.TemporaryDirectory() as directory:
    env = {**os.environ, 'DATA_DIR': directory, 'DEBUG': '1'}
    subprocess.run([sys.executable, 'manage.py', 'migrate', '--noinput'], env=env, check=True, stdout=subprocess.DEVNULL)
    setup = """
import os
os.environ.setdefault('DJANGO_SETTINGS_MODULE','config.settings')
import django
django.setup()
from django.contrib.auth import get_user_model
from inventory.models import Box, Draft
owner = get_user_model().objects.create_user('concurrency', is_staff=True)
box = Box.objects.create(number=9, category='Test')
draft = Draft.objects.create(owner=owner, box=box, entries=[{'name':'Screw'}])
print(draft.pk)
"""
    pk = subprocess.check_output([sys.executable, '-c', setup], env=env, text=True).strip()
    save = """
import os, sys, time
os.environ.setdefault('DJANGO_SETTINGS_MODULE','config.settings')
import django
django.setup()
from django.contrib.auth import get_user_model
from inventory.drafts import save
while time.time() < float(sys.argv[2]):
    time.sleep(.001)
print(save(sys.argv[1], get_user_model().objects.get(username='concurrency'), 0))
"""
    start = str(time.time() + 1)
    processes = [subprocess.Popen([sys.executable, '-c', save, pk, start], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) for _ in range(2)]
    try:
        outputs = [process.communicate(timeout=15) for process in processes]
        assert all(process.returncode == 0 for process in processes), 'Concurrent save failed'
        assert outputs[0][0] == outputs[1][0], 'Receipts differ'
        with sqlite3.connect(Path(directory) / 'inventory.sqlite3') as database:
            assert database.execute('SELECT count(*) FROM inventory_item').fetchone()[0] == 1
    finally:
        for process in processes:
            if process.poll() is None:
                process.kill()
                process.wait()
print('Concurrent save passed: one item and matching receipts')
