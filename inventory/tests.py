import json
from django.test import TestCase, Client, override_settings
from django.contrib.auth import get_user_model
from .models import Box, Item, Flag
from .access import buckets

@override_settings(SECURE_SSL_REDIRECT=False, SESSION_COOKIE_SECURE=False)
class CoreTests(TestCase):
    def setUp(self):
        buckets.clear()
        self.owner = get_user_model().objects.create_user('owner', password='test-password', is_staff=True)
        self.box = Box.objects.create(number=12, category='Hardware')
    def post(self, url, data):
        return self.client.post(url, data=json.dumps(data), content_type='application/json')
    def test_access_and_stale_edits(self):
        self.assertEqual(self.post('/api/items/create/', {}).status_code, 403)
        self.client.force_login(self.owner)
        data = {'name': 'M3 assortment', 'description': '16 mm screws', 'box': 12}
        created = self.post('/api/items/create/', data)
        self.assertEqual(created.status_code, 201)
        item_id = created.json()['id']
        data['revision'] = 0
        self.assertEqual(self.post(f'/api/items/{item_id}/edit/', data).status_code, 200)
        self.assertEqual(self.post(f'/api/items/{item_id}/edit/', data).status_code, 409)
        self.assertEqual(len(self.client.get('/api/search/?q=16%20mm').json()['items']), 1)
    def test_flags_survive_deletion(self):
        item = Item.objects.create(box=self.box, name='Screws')
        self.assertEqual(self.post('/api/boxes/12/flags/', {'item': item.pk, 'reason': 'missing'}).status_code, 201)
        self.assertEqual(self.client.get('/api/flags/').status_code, 403)
        item.delete()
        self.assertEqual(Flag.objects.get().item_name, 'Screws')
        self.assertIsNone(Flag.objects.get().item_id)
        self.client.force_login(self.owner)
        self.assertEqual(self.post('/api/flags/1/', {'status':'resolved'}).status_code, 200)
    def test_retired_numbers_cannot_be_reused(self):
        self.client.force_login(self.owner)
        self.assertEqual(self.post('/api/boxes/12/edit/', {'revision':0,'category':'Old','retired':True}).status_code, 200)
        self.assertEqual(self.post('/api/boxes/create/', {'number':12,'category':'New'}).status_code, 409)
    def test_csrf_login_and_logout(self):
        client = Client(enforce_csrf_checks=True)
        self.assertEqual(client.post('/api/login/', '{}', content_type='application/json').status_code, 403)
        token = client.get('/api/session/').json()['csrfToken']
        result = client.post('/api/login/', json.dumps({'username':'owner','password':'test-password'}), content_type='application/json', HTTP_X_CSRFTOKEN=token)
        self.assertEqual(result.status_code, 200)
        self.assertEqual(client.post('/api/logout/', '{}', content_type='application/json', HTTP_X_CSRFTOKEN=result.json()['csrfToken']).status_code, 200)
        self.assertFalse(client.get('/api/session/').json()['owner'])
    def test_flag_box_mismatch(self):
        other = Box.objects.create(number=2, category='Other')
        item = Item.objects.create(box=other, name='Cable')
        self.assertEqual(self.post('/api/boxes/12/flags/', {'item':item.pk,'reason':'missing'}).status_code, 404)

import io
import tempfile
from pathlib import Path
from unittest.mock import patch
from datetime import timedelta
from PIL import Image
from django.core.files.uploadedfile import SimpleUploadedFile
from django.utils import timezone
from .models import Draft
from . import drafts

@override_settings(SECURE_SSL_REDIRECT=False, SESSION_COOKIE_SECURE=False)
class DraftTests(TestCase):
    def setUp(self):
        CoreTests.setUp(self)
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.override = override_settings(PHOTO_ROOT=Path(self.temp.name))
        self.override.enable()
        self.addCleanup(self.override.disable)
        self.client.force_login(self.owner)
    def make_draft(self):
        output = io.BytesIO()
        Image.new('RGB', (64,64), 'red').save(output, format='JPEG')
        return drafts.upload(self.owner, self.box, [SimpleUploadedFile('photo.jpg', output.getvalue())])
    def test_save_once_and_cleanup(self):
        draft = self.make_draft()
        drafts.update(draft.pk, self.owner, 0, [{'name':'Screw kit'}])
        with self.captureOnCommitCallbacks(execute=True):
            receipt = drafts.save(draft.pk, self.owner, 1)
        self.assertEqual(drafts.save(draft.pk, self.owner, 1), receipt)
        self.assertEqual(Item.objects.count(), 1)
        self.assertFalse(drafts.directory(draft).exists())
    def test_failed_save_rolls_back(self):
        draft = self.make_draft()
        drafts.update(draft.pk, self.owner, 0, [{'name':'Screw kit'}])
        with patch('inventory.drafts.Item.objects.create', side_effect=RuntimeError('fail')):
            with self.assertRaises(RuntimeError):
                drafts.save(draft.pk, self.owner, 1)
        draft.refresh_from_db()
        self.assertEqual(draft.state, 'open')
        self.assertTrue(drafts.directory(draft).exists())
    def test_cleanup_retry_and_expiry(self):
        draft = self.make_draft()
        with patch('inventory.drafts.shutil.rmtree', side_effect=OSError('fail')):
            with self.captureOnCommitCallbacks(execute=True):
                drafts.cancel(draft.pk, self.owner)
        self.assertTrue(drafts.directory(draft).exists())
        drafts.cleanup()
        self.assertFalse(drafts.directory(draft).exists())
        expired = self.make_draft()
        Draft.objects.filter(pk=expired.pk).update(expires_at=timezone.now()-timedelta(seconds=1))
        drafts.cleanup()
        expired.refresh_from_db()
        self.assertEqual(expired.state, 'expired')
        self.assertFalse(drafts.directory(expired).exists())
    def test_photo_access_and_validation(self):
        draft = self.make_draft()
        url = f'/api/drafts/{draft.pk}/photos/0/'
        response = self.client.get(url)
        self.assertEqual(response.status_code, 200)
        response.close()
        self.client.logout()
        self.assertEqual(self.client.get(url).status_code, 403)
        with self.assertRaises(ValueError):
            drafts.upload(self.owner, self.box, [SimpleUploadedFile('bad.jpg', b'not an image')])

from unittest.mock import AsyncMock
from . import ai

@override_settings(SECURE_SSL_REDIRECT=False, NVIDIA_API_KEY='test', OPENROUTER_API_KEY='test')
class AITests(TestCase):
    def test_fallback_and_schema_validation(self):
        with patch('inventory.ai.request', new_callable=AsyncMock) as call:
            call.side_effect = [ai.Retryable('down'), ([{'name':'Cable'}], 'free-model')]
            self.assertEqual(ai.complete([], __import__('inventory.validation',fromlist=['entries']).entries)[0]['name'], 'Cable')
            self.assertEqual(call.await_count, 2)
        with patch('inventory.ai.request', new_callable=AsyncMock) as call:
            call.side_effect = [({'invalid':True}, 'primary'), ([], 'free-model')]
            self.assertEqual(ai.complete([], __import__('inventory.validation',fromlist=['entries']).entries), [])
            self.assertEqual(call.await_count, 2)
    def test_no_fallback_for_refusal_or_valid_empty(self):
        with patch('inventory.ai.request', new_callable=AsyncMock) as call:
            call.side_effect = ai.AIError('refused')
            with self.assertRaises(ai.AIError):
                ai.complete([], lambda x:x)
            self.assertEqual(call.await_count, 1)
        with patch('inventory.ai.request', new_callable=AsyncMock, return_value=([], 'primary')) as call:
            self.assertEqual(ai.complete([], lambda x:x), [])
            self.assertEqual(call.await_count, 1)
    def test_search_rejects_hallucination_and_reloads_location(self):
        buckets.clear()
        box=Box.objects.create(number=1,category='PC')
        item=Item.objects.create(box=box,name='HDMI cable')
        with patch('inventory.ai.complete', return_value=[{'id':999,'explanation':'invented'}]):
            self.assertEqual(self.client.post('/api/search/ai/',json.dumps({'question':'connect a monitor'}),content_type='application/json').status_code,502)
        with patch('inventory.ai.complete', return_value=[{'id':item.pk,'explanation':'Check ports'}]):
            result=self.client.post('/api/search/ai/',json.dumps({'question':'connect a monitor'}),content_type='application/json')
            self.assertEqual(result.json()['matches'][0]['box'],1)
    def test_late_analysis_cannot_restore_cancelled_draft(self):
        owner=get_user_model().objects.create_user('owner',is_staff=True)
        self.client.force_login(owner)
        box=Box.objects.create(number=1,category='Parts')
        draft=Draft.objects.create(owner=owner,box=box,files=['fake.jpg'])
        def late(*args):
            drafts.cancel(draft.pk,owner)
            return [{'name':'late','description':'','aliases':''}]
        with patch('pathlib.Path.read_bytes',return_value=b'fake'), patch('inventory.ai.complete',side_effect=late):
            result=self.client.post(f'/api/drafts/{draft.pk}/analyze/',json.dumps({'revision':0}),content_type='application/json')
        self.assertEqual(result.status_code,409)
        draft.refresh_from_db()
        self.assertEqual(draft.state,'cancelled')
        self.assertEqual(draft.entries,[])

import asyncio
import httpx
from .validation import entries as validate_entries

class TransportTests(TestCase):
    def run_response(self, status, payload):
        real_client=httpx.AsyncClient
        transport=httpx.MockTransport(lambda req:httpx.Response(status,json=payload))
        with patch('inventory.ai.httpx.AsyncClient',side_effect=lambda **kwargs:real_client(transport=transport,**kwargs)):
            return asyncio.run(ai.request('test','key','model','https://example.test',[]))
    def test_transport_error_classification(self):
        for status in [410,429,500,503]:
            with self.assertRaises(ai.Retryable): self.run_response(status,{})
        for status in [400,401,403]:
            with self.assertRaises(ai.AIError) as error: self.run_response(status,{})
            self.assertNotIsInstance(error.exception,ai.Retryable)
        with self.assertRaises(ai.Retryable): self.run_response(200,{'choices':[]})
        with self.assertRaises(ai.AIError): self.run_response(200,{'choices':[{'message':{'refusal':'no'}}]})
        result,_=self.run_response(200,{'choices':[{'message':{'content':'```json\n[]\n```'}}]})
        self.assertEqual(result,[])
    def test_whole_call_deadline(self):
        async def slow(*args,**kwargs):
            await asyncio.sleep(1)
        real_timeout=asyncio.timeout
        with patch('inventory.ai.request',side_effect=slow), patch('inventory.ai.asyncio.timeout',side_effect=lambda seconds:real_timeout(.01)):
            with self.assertRaises(ai.AIError): ai.complete([],validate_entries)

class NormalizationTests(TestCase):
    def test_ai_alias_lists_are_bounded(self):
        self.assertEqual(ai.suggestions([{'name':'M3 screws','aliases':['M3 bolts','fasteners']}])[0]['aliases'],'M3 bolts, fasteners')
        with self.assertRaises(ValueError): ai.suggestions([{'name':'M3','aliases':[{}]}])

from django.test import TransactionTestCase
from django.db import connection
from django.core.management import call_command
import sqlite3

class BackupTests(TransactionTestCase):
    def test_backup_restores_inventory_without_draft_payload(self):
        owner=get_user_model().objects.create_user('backupowner',is_staff=True)
        box=Box.objects.create(number=4,category='Parts')
        draft=Draft.objects.create(owner=owner,box=box,entries=[{'name':'PRIVATE DRAFT PAYLOAD'}],files=['private.jpg'])
        item=Item.objects.create(box=box,name='M3 assortment',draft=draft,draft_row=0)
        with tempfile.TemporaryDirectory() as directory:
            source=Path(directory)/'source.sqlite3'
            target=Path(directory)/'backup.sqlite3'
            with sqlite3.connect(source) as dest:
                connection.connection.backup(dest)
            from django.conf import settings
            databases={**settings.DATABASES,'default':{**settings.DATABASES['default'],'NAME':source}}
            with override_settings(DATABASES=databases):
                call_command('backup_inventory',str(target),stdout=io.StringIO())
            with sqlite3.connect(target) as restored:
                self.assertEqual(restored.execute('SELECT name FROM inventory_item').fetchone()[0],'M3 assortment')
                self.assertEqual(restored.execute('SELECT entries,files,state FROM inventory_draft').fetchone(),('[]','[]','expired'))
                self.assertEqual(restored.execute('PRAGMA foreign_key_check').fetchall(),[])
            self.assertNotIn(b'PRIVATE DRAFT PAYLOAD',target.read_bytes())
            self.assertEqual(target.stat().st_mode & 0o777,0o600)

@override_settings(SECURE_SSL_REDIRECT=False)
class DraftJourneyTests(TestCase):
    def test_upload_analyze_review_save_and_flag(self):
        buckets.clear()
        owner=get_user_model().objects.create_user('journey',is_staff=True)
        box=Box.objects.create(number=12,category='Hardware')
        self.client.force_login(owner)
        with tempfile.TemporaryDirectory() as directory, override_settings(PHOTO_ROOT=Path(directory)):
            stream=io.BytesIO();Image.new('RGB',(64,64),'white').save(stream,format='PNG')
            response=self.client.post('/api/boxes/12/drafts/',{'photos':SimpleUploadedFile('photo.png',stream.getvalue())})
            self.assertEqual(response.status_code,201)
            pk=response.json()['id']
            def post(path,data):
                return self.client.post(path,json.dumps(data),content_type='application/json')
            with patch('inventory.ai.complete',return_value=[{'name':'Screws','description':'','aliases':''}]):
                self.assertEqual(post(f'/api/drafts/{pk}/analyze/',{'revision':0}).status_code,200)
            review=post(f'/api/drafts/{pk}/',{'revision':1,'entries':[{'name':'M3 assortment','description':'16 mm screws','aliases':'fasteners'}]})
            self.assertEqual(review.status_code,200)
            with self.captureOnCommitCallbacks(execute=True):
                save=post(f'/api/drafts/{pk}/save/',{'revision':2})
            self.assertEqual(save.status_code,200)
            self.assertFalse((Path(directory)/pk).exists())
            self.client.logout()
            result=self.client.get('/api/search/?q=16%20mm').json()['items'][0]
            self.assertEqual(result['box'],12)
            self.assertEqual(post('/api/boxes/12/flags/',{'item':result['id'],'reason':'taken'}).status_code,201)

@override_settings(SECURE_SSL_REDIRECT=False)
class InterfaceTests(TestCase):
    def test_household_pages_escape_data_and_hide_owner_controls(self):
        box=Box.objects.create(number=12,category='<script>alert(1)</script>')
        Item.objects.create(box=box,name='<img src=x onerror=alert(1)>')
        result=self.client.get('/box/12')
        self.assertEqual(result.status_code,200)
        self.assertContains(result,'&lt;script&gt;')
        self.assertNotContains(result,'<script>alert(1)</script>')
        self.assertNotContains(result,'data-action="edit-box"')
        self.assertEqual(self.client.get('/api/boxes/12/').json()['number'],12)
        self.assertEqual(self.client.get('/flags').status_code,302)
    def test_owner_pages_and_empty_index(self):
        self.assertContains(self.client.get('/'),'A fresh start.')
        owner=get_user_model().objects.create_user('interface',is_staff=True)
        self.client.force_login(owner)
        self.assertContains(self.client.get('/'),'data-action="new-box"')
        self.assertContains(self.client.get('/flags'),'All caught up.')
