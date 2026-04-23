from rest_framework.routers import DefaultRouter

from apps.bots.api.views import (
    BotConfigViewSet,
    EmulationTradeViewSet,
    TradeViewSet,
    TraderRuntimeConfigViewSet,
)

router = DefaultRouter()
router.register("trades", EmulationTradeViewSet, basename="bot-trades")
router.register("real-trades", TradeViewSet, basename="real-trades")
router.register("runtime-configs", TraderRuntimeConfigViewSet, basename="trader-runtime-config")
router.register("", BotConfigViewSet, basename="bot-config")

urlpatterns = router.urls
