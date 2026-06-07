from django.urls import path
from rest_framework.routers import DefaultRouter

from apps.levels.api.views import (
    FavoriteCoinViewSet,
    LevelAnalysisViewSet,
    LevelNotificationConfigView,
    ServiceNotificationConfigsView,
)

router = DefaultRouter()
router.register("analyses", LevelAnalysisViewSet, basename="level-analysis")
router.register("favorites", FavoriteCoinViewSet, basename="favorite-coin")

# Notification config is a per-user singleton (not a collection), so it is a plain
# path, not a router resource. The plural `notification-configs/` is the
# service-token read endpoint for the level-notifier worker.
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
]
