from rest_framework.routers import DefaultRouter

from apps.bots.api.views import BotConfigViewSet, EmulationTradeViewSet, TradeViewSet

router = DefaultRouter()
router.register("trades", EmulationTradeViewSet, basename="bot-trades")
router.register("real-trades", TradeViewSet, basename="real-trades")
router.register("", BotConfigViewSet, basename="bot-config")

urlpatterns = router.urls
