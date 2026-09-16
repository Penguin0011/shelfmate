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
        old = timezone.now() - timedelta(days=1)
        Box.objects.filter(pk=self.box.pk).update(updated_at=old)
        data = {'name': 'M3 assortment', 'description': '16 mm screws', 'box': 12}
        created = self.post('/api/items/create/', data)
        self.assertEqual(created.status_code, 201)
        self.box.refresh_from_db()
        self.assertGreater(self.box.updated_at, old)
        self.assertEqual(self.client.get('/').context['last_change'], self.box.updated_at)
        item_id = created.json()['id']
        data['revision'] = 0
        self.assertEqual(self.post(f'/api/items/{item_id}/edit/', data).status_code, 200)
        self.assertEqual(self.post(f'/api/items/{item_id}/edit/', data).status_code, 409)
        self.assertEqual(len(self.client.get('/api/search/?q=16%20mm').json()['items']), 1)
    def test_flags_survive_deletion(self):
        item = Item.objects.create(box=self.box, name='Screws')
        self.assertEqual(self.post('/api/boxes/12/flags/', {'item': item.pk, 'reason': 'missing'}).status_code, 201)
        self.assertEqual(self.post('/api/flags/1/', {'status':'resolved'}).status_code, 403)
        item.delete()
        self.assertEqual(Flag.objects.get().item_name, 'Screws')
        self.assertIsNone(Flag.objects.get().item_id)
        self.client.force_login(self.owner)
        self.assertEqual(self.post('/api/flags/1/', {'status':'resolved'}).status_code, 200)
    def test_archived_number_can_be_reused_without_replacing_history(self):
        self.client.force_login(self.owner)
        flag = Flag.objects.create(box=self.box, reason='other', note='Keep this history')
        self.assertEqual(self.post('/api/boxes/12/edit/', {'revision':0,'category':'Old','retired':True}).status_code, 200)
        self.assertContains(self.client.get('/'), 'Archived boxes')
        self.assertContains(self.client.get('/box/12'), 'Restore / reuse Box 12')
        # Reuse is deliberate, never a side effect: without an explicit restore the archived number
        # is refused, and the refusal is marked so the client can offer the reuse rather than guess.
        refused = self.post('/api/boxes/create/', {'number':12,'category':'New'})
        self.assertEqual(refused.status_code, 409)
        self.assertTrue(refused.json()['archived'])
        self.assertEqual(Box.objects.get(number=12).category, 'Old', 'a refused reuse must change nothing')
        self.assertTrue(Box.objects.get(number=12).retired)
        self.assertEqual(self.post('/api/boxes/create/', {'number':12,'category':'New','restore':'yes'}).status_code, 400)
        restored = self.post('/api/boxes/create/', {'number':12,'category':'New','restore':True})
        self.assertEqual(restored.status_code, 200)
        self.assertTrue(restored.json()['restored'])
        self.box.refresh_from_db()
        self.assertEqual(self.box.category, 'New')
        self.assertFalse(self.box.retired)
        self.assertEqual(Flag.objects.get(pk=flag.pk).box_id, self.box.pk)
        self.assertEqual(Box.objects.filter(number=12).count(), 1)
        # Now active again, so even an explicit restore must not silently take it over.
        self.assertEqual(self.post('/api/boxes/create/', {'number':12,'category':'Duplicate'}).status_code, 409)
        self.assertEqual(self.post('/api/boxes/create/', {'number':12,'category':'Duplicate','restore':True}).status_code, 409)
        self.client.logout()
        self.assertNotContains(self.client.get('/'), 'Archived boxes')
    def test_suggested_box_number_skips_archived_numbers(self):
        # The suggestion must clear retired numbers too: box_create turns an existing retired number
        # into a *restore*, so suggesting one would revive an archived box instead of making a new
        # one -- and point the owner at an NFC tag already stuck to a physical box.
        self.client.force_login(self.owner)
        self.assertEqual(self.client.get('/').context['bootstrap']['next_number'], 13)
        self.assertEqual(self.post('/api/boxes/create/', {'number':30,'category':'Tools'}).status_code, 201)
        self.assertEqual(self.post('/api/boxes/30/edit/', {'revision':0,'category':'Tools','retired':True}).status_code, 200)
        self.assertEqual(self.client.get('/').context['bootstrap']['next_number'], 31)
        self.client.logout()
        self.assertIsNone(self.client.get('/').context['bootstrap']['next_number'])
    def test_location_validation_and_visibility(self):
        self.client.force_login(self.owner)
        response = self.post('/api/boxes/create/', {'number':21,'category':'Parts','location':' Office '})
        self.assertEqual(response.status_code, 201)
        self.assertEqual(self.post('/api/boxes/21/edit/', {'revision':0,'category':'Parts','location':'Garage'}).status_code, 200)
        self.assertEqual(self.post('/api/boxes/create/', {'number':22,'category':'Tools','location':'office'}).status_code, 201)
        self.assertEqual(Box.objects.get(number=22).location, 'office')
        self.assertEqual(self.post('/api/boxes/21/edit/', {'revision':1,'category':'Parts','location':None}).status_code, 400)
        self.assertEqual(self.post('/api/boxes/21/edit/', {'revision':1,'category':'Parts','location':'x'*121}).status_code, 400)
        self.assertEqual(self.post('/api/boxes/21/edit/', {'revision':1,'category':'Parts'}).status_code, 200)
        self.assertEqual(Box.objects.get(number=21).location, 'Garage')
        self.assertEqual(self.client.get('/').context['bootstrap']['locations'], ['Garage', 'office'])
        self.assertEqual(self.post('/api/boxes/21/edit/', {'revision':2,'category':'Parts','location':''}).status_code, 200)
        self.assertEqual(self.client.get('/').context['bootstrap']['locations'], ['office'])
        Item.objects.create(box=Box.objects.get(number=22), name='Spare screw')
        self.client.logout()
        self.assertContains(self.client.get('/box/22'), 'office')
        self.assertEqual(self.client.get('/api/search/?q=Spare').json()['items'][0]['location'], 'office')
        self.assertEqual(self.post('/api/boxes/22/edit/', {'revision':0,'category':'Tools','location':'Closet'}).status_code, 403)

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
class BulkItemTests(TestCase):
    def setUp(self):
        self.owner = get_user_model().objects.create_user('owner2', password='test-password', is_staff=True)
        self.client = Client()
        self.client.force_login(self.owner)
        self.box = Box.objects.create(number=40, category='Parts')
        self.other = Box.objects.create(number=41, category='Spares')
        self.items = [Item.objects.create(box=self.box, name=f'Item {n}') for n in range(4)]

    def post(self, payload):
        return self.client.post('/api/items/bulk/', json.dumps(payload), content_type='application/json')

    def selection(self, items=None):
        return [{'id': i.pk, 'revision': i.revision} for i in (items if items is not None else self.items)]

    def test_bulk_delete_empties_a_box_so_it_can_be_archived(self):
        # The point of the feature: box_edit refuses retirement while items remain.
        old = timezone.now() - timedelta(days=1)
        Box.objects.filter(pk=self.box.pk).update(updated_at=old)
        response = self.client.post(f'/api/boxes/{self.box.number}/edit/',
            json.dumps({'revision': self.box.revision, 'category': 'Parts', 'retired': True}), content_type='application/json')
        self.assertEqual(response.status_code, 400)
        self.assertEqual(self.post({'action': 'delete', 'items': self.selection()}).status_code, 200)
        self.assertEqual(Item.objects.filter(box=self.box).count(), 0)
        self.box.refresh_from_db()
        self.assertGreater(self.box.updated_at, old)
        response = self.client.post(f'/api/boxes/{self.box.number}/edit/',
            json.dumps({'revision': self.box.revision, 'category': 'Parts', 'retired': True}), content_type='application/json')
        self.assertEqual(response.status_code, 200, 'an emptied box must now be archivable')

    def test_bulk_delete_keeps_flag_history(self):
        flag = Flag.objects.create(box=self.box, item=self.items[0], item_name=self.items[0].name, reason='missing')
        self.assertEqual(self.post({'action': 'delete', 'items': self.selection([self.items[0]])}).status_code, 200)
        flag.refresh_from_db()
        self.assertIsNone(flag.item)
        self.assertEqual(flag.item_name, 'Item 0')

    def test_bulk_move_transfers_and_bumps_revisions(self):
        response = self.post({'action': 'move', 'items': self.selection(), 'box': self.other.number})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(Item.objects.filter(box=self.other).count(), 4)
        self.assertEqual(Item.objects.filter(box=self.box).count(), 0)
        self.assertTrue(all(i.revision == 1 for i in Item.objects.all()))

    def test_bulk_move_into_a_retired_box_is_refused(self):
        self.other.retired = True
        self.other.save(update_fields=['retired'])
        self.assertEqual(self.post({'action': 'move', 'items': self.selection(), 'box': self.other.number}).status_code, 404)
        self.assertEqual(Item.objects.filter(box=self.box).count(), 4, 'nothing may move into a retired box')

    def test_stale_revision_rejects_the_whole_batch(self):
        self.items[2].name = 'Changed elsewhere'
        self.items[2].revision += 1
        self.items[2].save()
        stale = [{'id': i.pk, 'revision': 0} for i in self.items]
        response = self.post({'action': 'delete', 'items': stale})
        self.assertEqual(response.status_code, 409)
        self.assertEqual(Item.objects.filter(box=self.box).count(), 4, 'a conflicting batch must not partly apply')

    def test_rejects_malformed_selections(self):
        self.assertEqual(self.post({'action': 'delete', 'items': []}).status_code, 400)
        self.assertEqual(self.post({'action': 'delete', 'items': 'all'}).status_code, 400)
        self.assertEqual(self.post({'action': 'burn', 'items': self.selection()}).status_code, 400)
        duplicate = self.selection([self.items[0]]) * 2
        self.assertEqual(self.post({'action': 'delete', 'items': duplicate}).status_code, 400)
        missing = [{'id': 99999, 'revision': 0}]
        self.assertEqual(self.post({'action': 'delete', 'items': missing}).status_code, 409)
        self.assertEqual(Item.objects.filter(box=self.box).count(), 4)

    def test_requires_owner(self):
        self.client.logout()
        self.assertEqual(self.post({'action': 'delete', 'items': self.selection()}).status_code, 403)
        self.assertEqual(Item.objects.filter(box=self.box).count(), 4)


@override_settings(SECURE_SSL_REDIRECT=False)
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

from . import ai

@override_settings(SECURE_SSL_REDIRECT=False, FIREWORKS_API_KEY='', GEMINI_API_KEY='', NVIDIA_API_KEY='test', OPENROUTER_API_KEY='test')
class AITests(TestCase):
    def test_fallback_and_schema_validation(self):
        with patch('inventory.ai.request') as call:
            call.side_effect = [ai.Retryable('down'), ([{'name':'Cable'}], 'free-model')]
            self.assertEqual(ai.complete([], __import__('inventory.validation',fromlist=['entries']).entries)[0]['name'], 'Cable')
            self.assertEqual(call.call_count, 2)
        with patch('inventory.ai.request') as call:
            call.side_effect = [({'invalid':True}, 'primary'), ([], 'free-model')]
            self.assertEqual(ai.complete([], __import__('inventory.validation',fromlist=['entries']).entries), [])
            self.assertEqual(call.call_count, 2)
    def test_no_fallback_for_refusal_or_valid_empty(self):
        with patch('inventory.ai.request') as call:
            call.side_effect = ai.Refused('refused')
            with self.assertRaises(ai.AIError):
                ai.complete([], lambda x:x)
            self.assertEqual(call.call_count, 1, 'a content refusal must not shop the next provider')
        with patch('inventory.ai.request', return_value=([], 'primary')) as call:
            self.assertEqual(ai.complete([], lambda x:x), [])
            self.assertEqual(call.call_count, 1)
    def test_unconfigured_providers_are_skipped_not_fatal(self):
        # A missing key raises AIError, which is deliberately not retryable. If that escaped the
        # provider loop it would abort the whole chain, so an unset key must skip instead.
        entries = __import__('inventory.validation', fromlist=['entries']).entries
        with override_settings(FIREWORKS_API_KEY='', GEMINI_API_KEY='', OPENROUTER_API_KEY='', NVIDIA_API_KEY='configured'):
            with patch('inventory.ai.request') as call:
                call.side_effect = [([{'name': 'Cable'}], 'nvidia-model')]
                self.assertEqual(ai.complete([], entries)[0]['name'], 'Cable')
                self.assertEqual(call.call_count, 1)
                self.assertEqual(call.call_args.args[0], 'NVIDIA')
        with override_settings(FIREWORKS_API_KEY='', GEMINI_API_KEY='', OPENROUTER_API_KEY='', NVIDIA_API_KEY=''):
            with patch('inventory.ai.request') as call:
                with self.assertRaises(ai.AIError):
                    ai.complete([], entries)
                self.assertEqual(call.call_count, 0)
    def test_fireworks_is_tried_before_the_slower_providers(self):
        entries = __import__('inventory.validation', fromlist=['entries']).entries
        with override_settings(FIREWORKS_API_KEY='f', GEMINI_API_KEY='g', OPENROUTER_API_KEY='o', NVIDIA_API_KEY='n'):
            with patch('inventory.ai.request') as call:
                call.side_effect = [([{'name': 'Screws'}], 'fireworks-model')]
                self.assertEqual(ai.complete([], entries)[0]['name'], 'Screws')
                self.assertEqual(call.call_count, 1)
                self.assertEqual(call.call_args.args[0], 'Fireworks')
    def test_verbose_descriptions_degrade_search_instead_of_breaking_it(self):
        # Verbose descriptions are the point of the recognition prompt, but AI search sends the whole
        # inventory as context. A flat refusal would disable search after roughly one box, so the
        # payload is trimmed in stages and names/aliases -- what matching needs -- survive longest.
        buckets.clear()
        box = Box.objects.create(number=3, category='Parts')
        for n in range(12):
            Item.objects.create(box=box, name=f'Item {n}', description='D'*1800, aliases='A'*900)
        captured = {}
        def capture(messages, validate):
            captured['payload'] = json.loads(messages[1]['content'])['inventory']
            return []
        with override_settings(AI_SEARCH_BUDGET=12500):
            with patch('inventory.ai.complete', side_effect=capture):
                response = self.client.post('/api/search/ai/', json.dumps({'question':'screws'}), content_type='application/json')
        self.assertEqual(response.status_code, 200)
        rows = captured['payload']
        self.assertEqual(len(rows), 12, 'every item must still be offered to the model')
        self.assertTrue(all('aliases' in r and 'name' in r and 'id' in r for r in rows))
        self.assertTrue(all('description' not in r for r in rows), 'descriptions drop before items do')
        # A budget that fits trimmed descriptions keeps them, rather than dropping straight to names.
        buckets.clear()
        with override_settings(AI_SEARCH_BUDGET=18000):
            with patch('inventory.ai.complete', side_effect=capture):
                self.client.post('/api/search/ai/', json.dumps({'question':'screws'}), content_type='application/json')
        self.assertTrue(all(len(r['description']) <= 300 for r in captured['payload']))
    def test_provider_rejection_falls_through_to_the_next_provider(self):
        # 400 bad parameters, a stale key, or a model retired out from under us are all provider-level
        # failures that say nothing about the providers behind them. Only a content refusal stops the
        # chain. gemini-2.5-flash returning 404 "no longer available to new users" is the real case.
        entries = __import__('inventory.validation', fromlist=['entries']).entries
        with override_settings(FIREWORKS_API_KEY='f', GEMINI_API_KEY='g', OPENROUTER_API_KEY='o', NVIDIA_API_KEY='n'):
            with patch('inventory.ai.request') as call:
                call.side_effect = [ai.AIError('Fireworks rejected the request'),
                                    ai.AIError('Gemini rejected the request'),
                                    ai.AIError('OpenRouter authentication or access failed'),
                                    ([{'name': 'Screws'}], 'nvidia-model')]
                self.assertEqual(ai.complete([], entries)[0]['name'], 'Screws')
                self.assertEqual(call.call_count, 4)
            # Every provider rejecting still ends as a single AIError, not a leaked provider message.
            with patch('inventory.ai.request') as call:
                call.side_effect = ai.AIError('rejected')
                with self.assertRaises(ai.AIError):
                    ai.complete([], entries)
                self.assertEqual(call.call_count, 4)
            # A refusal from the first provider still stops immediately.
            with patch('inventory.ai.request') as call:
                call.side_effect = [ai.Refused('declined'), ([{'name': 'Screws'}], 'm')]
                with self.assertRaises(ai.Refused):
                    ai.complete([], entries)
                self.assertEqual(call.call_count, 1)
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

import httpx
import time
from .validation import entries as validate_entries

class TransportTests(TestCase):
    def run_response(self, status, payload):
        real_client=httpx.Client
        transport=httpx.MockTransport(lambda req:httpx.Response(status,json=payload))
        with patch('inventory.ai.httpx.Client',side_effect=lambda **kwargs:real_client(transport=transport,**kwargs)):
            return ai.request('test','key','model','https://example.test',[])
    def test_transport_error_classification(self):
        for status in [410,429,500,503]:
            with self.assertRaises(ai.Retryable): self.run_response(status,{})
        for status in [400,401,403]:
            with self.assertRaises(ai.AIError) as error: self.run_response(status,{})
            self.assertNotIsInstance(error.exception,ai.Retryable)
        with self.assertRaises(ai.Retryable): self.run_response(200,{'choices':[]})
        with self.assertRaises(ai.Refused): self.run_response(200,{'choices':[{'message':{'refusal':'no'}}]})
        with self.assertRaises(ai.Refused): self.run_response(200,{'choices':[{'message':{'content':'x'},'finish_reason':'content_filter'}]})
        result,_=self.run_response(200,{'choices':[{'message':{'content':'```json\n[]\n```'}}]})
        self.assertEqual(result,[])
    def test_whole_call_deadline(self):
        def slow(*args,**kwargs):
            time.sleep(.02)
            return [], 'slow-model'
        with override_settings(AI_TOTAL_TIMEOUT=.01), patch('inventory.ai.request',side_effect=slow):
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

class SpokenDraftTests(TestCase):
    def test_transcript_only_draft_analyzes_and_saves_without_photos(self):
        buckets.clear()
        owner=get_user_model().objects.create_user('talker',is_staff=True)
        Box.objects.create(number=7,category='Workshop')
        self.client.force_login(owner)
        created=self.client.post('/api/boxes/7/drafts/',{'transcript':"there's a bag of M3 screws, no wait M4, and the grey USB hub"})
        self.assertEqual(created.status_code,201)
        self.assertEqual(created.json()['photos'],[])
        pk=created.json()['id']
        with patch('inventory.ai.complete',return_value=[{'name':'M4 screws','description':'','aliases':''}]) as call:
            self.assertEqual(self.client.post(f'/api/drafts/{pk}/analyze/',json.dumps({'revision':0}),content_type='application/json').status_code,200)
        # The spoken words must reach the model, and the prompt must not tell it to look at photos.
        sent=call.call_args[0][0][0]['content']
        self.assertNotIn('image_url',[part['type'] for part in sent])
        self.assertIn('M3 screws',sent[1]['text'])
        self.assertNotIn('photos attached',sent[0]['text'])
        with self.captureOnCommitCallbacks(execute=True):
            self.assertEqual(self.client.post(f'/api/drafts/{pk}/save/',json.dumps({'revision':1}),content_type='application/json').status_code,200)
        self.assertEqual(Item.objects.get().name,'M4 screws')

    def test_a_draft_needs_photos_or_words(self):
        owner=get_user_model().objects.create_user('empty',is_staff=True)
        Box.objects.create(number=8,category='Workshop')
        self.client.force_login(owner)
        self.assertEqual(self.client.post('/api/boxes/8/drafts/',{}).status_code,400)


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
        self.assertEqual(self.client.get('/flags').status_code,302)
    def test_owner_pages_and_empty_index(self):
        self.assertContains(self.client.get('/'),'A fresh start.')
        owner=get_user_model().objects.create_user('interface',is_staff=True)
        self.client.force_login(owner)
        self.assertContains(self.client.get('/'),'data-action="new-box"')
        self.assertContains(self.client.get('/flags'),'All caught up.')
