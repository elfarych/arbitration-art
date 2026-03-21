from rest_framework.routers import DefaultRouter

from apps.bots.api.views import BotConfigViewSet

router = DefaultRouter()
router.register("", BotConfigViewSet, basename="bot-config")

urlpatterns = router.urls
