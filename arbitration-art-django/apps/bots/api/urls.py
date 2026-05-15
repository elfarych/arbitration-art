from django.urls import path
from rest_framework.routers import DefaultRouter

from apps.bots.api.views import (
    BotConfigViewSet,
    EmulationTradeViewSet,
    PnlSummaryView,
    TradeViewSet,
    TraderRuntimeConfigErrorViewSet,
    TraderRuntimeConfigViewSet,
)

router = DefaultRouter()
router.register("trades", EmulationTradeViewSet, basename="bot-trades")
router.register("real-trades", TradeViewSet, basename="real-trades")
router.register("runtime-config-errors", TraderRuntimeConfigErrorViewSet, basename="trader-runtime-config-errors")
router.register("runtime-configs", TraderRuntimeConfigViewSet, basename="trader-runtime-config")
# `pnl/` must be declared before the empty-prefix BotConfigViewSet so the
# router does not interpret it as `BotConfig.retrieve(pk='pnl')`.
urlpatterns = [
    path("pnl/", PnlSummaryView.as_view(), name="bots-pnl-summary"),
]
router.register("", BotConfigViewSet, basename="bot-config")
urlpatterns += router.urls
