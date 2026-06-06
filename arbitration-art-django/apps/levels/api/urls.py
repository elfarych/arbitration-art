from rest_framework.routers import DefaultRouter

from apps.levels.api.views import LevelAnalysisViewSet

router = DefaultRouter()
router.register("analyses", LevelAnalysisViewSet, basename="level-analysis")

urlpatterns = router.urls
