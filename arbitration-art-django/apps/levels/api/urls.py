from rest_framework.routers import DefaultRouter

from apps.levels.api.views import FavoriteCoinViewSet, LevelAnalysisViewSet

router = DefaultRouter()
router.register("analyses", LevelAnalysisViewSet, basename="level-analysis")
router.register("favorites", FavoriteCoinViewSet, basename="favorite-coin")

urlpatterns = router.urls
