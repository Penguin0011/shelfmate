from django.urls import path
from inventory import views as v
from inventory import ui
urlpatterns = [
    path('', ui.page), path('health/', v.health), path('api/session/', v.session),
    path('api/login/', v.sign_in), path('api/logout/', v.sign_out),
    path('api/boxes/', v.boxes), path('api/boxes/create/', v.box_create),
    path('box/<int:number>', ui.page), path('api/boxes/<int:number>/', v.box_detail),
    path('api/boxes/<int:number>/edit/', v.box_edit),
    path('api/search/', v.search), path('api/items/create/', v.item_create),
    path('api/items/<int:pk>/edit/', v.item_edit),
    path('api/items/bulk/', v.item_bulk),
    path('api/boxes/<int:number>/flags/', v.flag_create),
    path('api/flags/', v.flags), path('api/flags/<int:pk>/', v.flag_edit),
]
from inventory import draft_views as d
urlpatterns += [
    path('api/boxes/<int:number>/drafts/', d.create),
    path('api/drafts/', d.listing), path('api/drafts/<uuid:pk>/', d.detail),
    path('api/drafts/<uuid:pk>/save/', d.save), path('api/drafts/<uuid:pk>/cancel/', d.cancel),
    path('api/drafts/<uuid:pk>/photos/<int:index>/', d.photo),
]
from inventory import ai_views as a
urlpatterns += [path('api/drafts/<uuid:pk>/analyze/', a.analyze), path('api/search/ai/', a.search)]

urlpatterns += [path('flags', ui.page, {'screen':'inbox'}), path('drafts/<uuid:draft_id>', ui.page)]
