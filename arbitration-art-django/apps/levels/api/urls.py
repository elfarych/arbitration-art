from django.urls import path
from rest_framework.routers import DefaultRouter

from apps.levels.api.views import (
    FavoriteCoinViewSet,
    LevelAnalysisViewSet,
    LevelNotificationConfigView,
    PriceNotificationViewSet,
    ServiceNotificationConfigsView,
    ServicePriceNotificationsView,
    ServicePriceNotificationTriggerView,
)

router = DefaultRouter()
router.register("analyses", LevelAnalysisViewSet, basename="level-analysis")
router.register("favorites", FavoriteCoinViewSet, basename="favorite-coin")
# Price alerts are a per-user collection (CRUD by id).
router.register("price-notifications", PriceNotificationViewSet, basename="price-notification")

# Notification config is a per-user singleton (not a collection), so it is a plain
# path, not a router resource. The plural `notification-configs/` is the
# service-token read endpoint for the level-notifier worker. The price-alert
# service endpoints live under `service/` to avoid colliding with the
# price-notifications router detail route (`price-notifications/<pk>/`).
urlpatterns = router.urls + [
    path(
        "notification-config/",
        LevelNotificationConfigView.as_view(),
        name="level-notification-config",
    ),
    path(
        "notification-configs/",
        ServiceNotificationConfigsView.as_view(),
        name="level-notification-configs",
    ),
    path(
        "service/price-notifications/",
        ServicePriceNotificationsView.as_view(),
        name="service-price-notifications",
    ),
    path(
        "service/price-notifications/<int:pk>/trigger/",
        ServicePriceNotificationTriggerView.as_view(),
        name="service-price-notification-trigger",
    ),
]
