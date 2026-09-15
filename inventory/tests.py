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
