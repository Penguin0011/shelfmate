from django.urls import path
from inventory import views as v
urlpatterns = [
    path('health/', v.health), path('api/session/', v.session),
    path('api/login/', v.sign_in), path('api/logout/', v.sign_out),
    path('api/boxes/', v.boxes), path('api/boxes/create/', v.box_create),
    path('box/<int:number>', v.box_detail),
    path('api/boxes/<int:number>/edit/', v.box_edit),
    path('api/search/', v.search), path('api/items/create/', v.item_create),
    path('api/items/<int:pk>/edit/', v.item_edit),
    path('api/boxes/<int:number>/flags/', v.flag_create),
    path('api/flags/', v.flags), path('api/flags/<int:pk>/', v.flag_edit),
]
