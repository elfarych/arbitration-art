from django.urls import path
from rest_framework_simplejwt.views import TokenObtainPairView, TokenRefreshView

from apps.users.api.views import (
    ExchangeKeysView,
    ExchangeKeyTestConnectionView,
    ExchangeKeyTestTradeView,
    LogoutView,
    MeView,
)

app_name = "auth"

urlpatterns = [
    path("login/", TokenObtainPairView.as_view(), name="login"),
    path("refresh/", TokenRefreshView.as_view(), name="refresh"),
    path("logout/", LogoutView.as_view(), name="logout"),
    path("me/", MeView.as_view(), name="me"),
    path("exchange-keys/", ExchangeKeysView.as_view(), name="exchange-keys"),
    path(
        "exchange-keys/<str:exchange>/test-connection/",
        ExchangeKeyTestConnectionView.as_view(),
        name="exchange-keys-test-connection",
    ),
    path(
        "exchange-keys/<str:exchange>/test-trade/",
        ExchangeKeyTestTradeView.as_view(),
        name="exchange-keys-test-trade",
    ),
]
